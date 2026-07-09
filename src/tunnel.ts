import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { cfFetch } from './cloudflare';
import { register } from './cleanup';
import type { DomainEntry } from './types';

const TUNNELS_DIR = path.join(os.homedir(), '.localmap', 'tunnels');

interface TunnelCredentials {
  AccountTag: string;
  TunnelID: string;
  TunnelName: string;
  TunnelSecret: string;
}

interface CfTunnel {
  id: string;
  name: string;
}

// Returns 'cloudflared' once the binary is available, installing it if needed.
export async function ensureCloudflared(): Promise<string> {
  if (spawnSync('which', ['cloudflared'], { stdio: 'ignore' }).status === 0) return 'cloudflared';

  console.log('  cloudflared not found — installing automatically...');

  if (process.platform === 'darwin') {
    if (spawnSync('which', ['brew'], { stdio: 'ignore' }).status !== 0) {
      console.error('\nHomebrew is required to install cloudflared on macOS.');
      console.error('Install Homebrew first: https://brew.sh\n');
      process.exit(1);
    }
    console.log('  Running: brew install cloudflared');
    const r = spawnSync('brew', ['install', 'cloudflared'], { stdio: 'inherit' });
    if (r.status !== 0) { console.error('\nFailed to install cloudflared via brew.\n'); process.exit(1); }
    return 'cloudflared';
  }

  if (process.platform === 'linux') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const url  = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
    console.log(`  Running: sudo curl -L ${url} -o /usr/local/bin/cloudflared`);
    const dl = spawnSync('sudo', ['curl', '-fsSL', url, '-o', '/usr/local/bin/cloudflared'], { stdio: 'inherit' });
    if (dl.status !== 0) { console.error('\nFailed to download cloudflared.\n'); process.exit(1); }
    spawnSync('sudo', ['chmod', '+x', '/usr/local/bin/cloudflared'], { stdio: 'inherit' });
    console.log('  Installed to /usr/local/bin/cloudflared');
    return 'cloudflared';
  }

  console.error('\ncloudflared auto-install is not supported on this platform.');
  console.error('Download it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n');
  process.exit(1);
}

// Create or reuse a named tunnel. Returns { id }.
// Credentials file is written to TUNNELS_DIR/{id}.json on first creation.
export async function ensureTunnel(
  apiToken: string,
  accountId: string,
  tunnelName: string,
): Promise<{ id: string }> {
  fs.mkdirSync(TUNNELS_DIR, { recursive: true });

  const list = await cfFetch<CfTunnel[]>(
    apiToken, 'GET',
    `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`,
  );
  const existing = list.result?.[0];

  if (existing) {
    const credPath = path.join(TUNNELS_DIR, `${existing.id}.json`);
    if (fs.existsSync(credPath)) {
      console.log(`  Tunnel "${tunnelName}" already exists  (${existing.id})`);
      return { id: existing.id };
    }
    // Credentials file missing — tunnel exists on CF but we lost the secret.
    // Delete it so we can recreate with fresh credentials.
    console.log(`  Credentials missing for existing tunnel — recreating...`);
    await cfFetch(apiToken, 'DELETE', `/accounts/${accountId}/cfd_tunnel/${existing.id}`);
  }

  const secret = crypto.randomBytes(32).toString('hex');
  const res = await cfFetch<CfTunnel>(apiToken, 'POST', `/accounts/${accountId}/cfd_tunnel`, {
    name: tunnelName,
    tunnel_secret: Buffer.from(secret).toString('base64'),
  });

  const tunnel = res.result!;
  const credPath = path.join(TUNNELS_DIR, `${tunnel.id}.json`);

  const credentials: TunnelCredentials = {
    AccountTag:   accountId,
    TunnelID:     tunnel.id,
    TunnelName:   tunnelName,
    TunnelSecret: Buffer.from(secret).toString('base64'),
  };
  fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });

  console.log(`  Tunnel "${tunnelName}" created  (${tunnel.id})`);
  return { id: tunnel.id };
}

// Write cloudflared config.yml. Called every startup so ingress stays in sync with config.
export function writeTunnelConfig(
  tunnelId: string,
  credentialsPath: string,
  domains: DomainEntry[],
  proxyPort: number,
  baseDomain: string,
): string {
  fs.mkdirSync(TUNNELS_DIR, { recursive: true });

  const ingressLines = domains
    .map(({ name }) => `  - hostname: ${name}.${baseDomain}\n    service: http://localhost:${proxyPort}`)
    .join('\n');

  const yaml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsPath}`,
    `ingress:`,
    ingressLines,
    `  - service: http_status:404`,
  ].join('\n') + '\n';

  // Per-tunnel filename so two dynamoip instances (different baseDomains) don't clobber each other.
  const configPath = path.join(TUNNELS_DIR, `config-${tunnelId}.yml`);
  fs.writeFileSync(configPath, yaml, { mode: 0o600 });
  return configPath;
}

// Spawn cloudflared with auto-restart on unexpected exit.
export function startTunnel(configPath: string, tunnelName: string, cloudflaredBin: string): void {
  function spawn_(): void {
    const cp = spawn(cloudflaredBin, ['tunnel', '--config', configPath, 'run'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    cp.stdout!.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.log(`[cloudflared] ${msg}`);
    });
    cp.stderr!.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error(`[cloudflared] ${msg}`);
    });
    cp.on('exit', (code, signal) => {
      if (signal !== 'SIGTERM') {
        console.error(`[cloudflared] exited unexpectedly (code=${code}), retrying in 5s...`);
        setTimeout(spawn_, 5000);
      }
    });

    register(cp);
  }

  spawn_();
}

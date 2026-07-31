#!/usr/bin/env node

import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import { loadConfig }    from '../src/config';
import { getLanIp }      from '../src/ip';
import { registerAll }   from '../src/mdns';
import { startProxy }    from '../src/proxy';
import { obtainCert, scheduleRenewal } from '../src/acme';
import { upsertARecords, upsertCnameRecords, getZoneId, getAccountId } from '../src/cloudflare';
import { checkMkcert, generateCerts, getCaCertPath } from '../src/certs';
import { ensureCloudflared, ensureTunnel, writeTunnelConfig, startTunnel, machineTag } from '../src/tunnel';
import { cleanup, onExit } from '../src/cleanup';
import type { SslOptions } from '../src/types';

// --- Argument parsing ---
const args  = process.argv.slice(2);
const noSsl = args.includes('--no-ssl');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
dynamoip - Expose local dev servers as real domains with trusted HTTPS

Usage:
  dynamoip [options]

Options:
  --config <path>   Path to config file (default: ./dynamoip.config.json)
  --port <n>        Override proxy port (default: 443 with SSL, 80 without)
  --no-ssl          Disable HTTPS (plain HTTP, mDNS .local only)
  --help            Show this help

--- Max mode (Cloudflare Tunnel — public internet access) ---
  Accessible from anywhere on the internet, not just your local network.
  No sudo required. Cloudflare handles TLS.

  dynamoip.config.json:
    { "baseDomain": "myteam.dev", "domains": { "app": 3000 }, "tunnel": true }

  .env:
    CF_API_TOKEN=your_token  (needs Zone:DNS:Edit + Account:Cloudflare Tunnel:Edit)

  Requires: cloudflared installed (brew install cloudflared)

--- Pro mode (Cloudflare + Let's Encrypt — LAN only) ---
  Trusted HTTPS on every LAN device. No cert installation needed.

  dynamoip.config.json:
    { "baseDomain": "local.myteam.dev", "domains": { "inventory": 3000 } }

  .env:
    CF_API_TOKEN=your_cloudflare_api_token
    CF_EMAIL=you@example.com   (optional, for cert expiry alerts)

--- Quick mode (mDNS .local — LAN only) ---
  Works on LAN only. Other devices need to install the CA cert once.

  dynamoip.config.json:
    { "domains": { "inventory": 3000 } }
`);
  process.exit(0);
}

let configPath   = './dynamoip.config.json';
let portOverride: number | null = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && args[i + 1]) configPath = args[++i];
  else if (args[i] === '--port' && args[i + 1]) {
    portOverride = parseInt(args[++i], 10);
    if (isNaN(portOverride) || portOverride < 1 || portOverride > 65535) {
      console.error(`Invalid --port value: ${args[i]}`); process.exit(1);
    }
  }
}

// --- Graceful restart ---
const MAX_RESTARTS   = 5;
const BASE_DELAY_MS  = 2000;
let restartCount     = 0;
let lastRestartTime  = 0;
let activeServers: (http.Server | https.Server)[] = [];
let renewalTimer: NodeJS.Timeout | null = null;

// Stop listening and let in-flight requests finish. Bounded, because a keep-alive or
// WebSocket connection would otherwise hold server.close() open indefinitely.
const SERVER_DRAIN_MS = 3000;

function closeActiveServers(): Promise<void> {
  const toClose = activeServers.splice(0);
  if (!toClose.length) return Promise.resolve();

  const closed = Promise.all(toClose.map(s => new Promise<void>(resolve => {
    s.close(() => resolve());
    s.closeIdleConnections?.();
  })));

  return Promise.race([
    closed.then(() => {}),
    new Promise<void>(resolve => setTimeout(resolve, SERVER_DRAIN_MS).unref()),
  ]).then(() => {
    for (const s of toClose) s.closeAllConnections?.();
  });
}

// Tear down everything main() spawned so a restart doesn't stack duplicate
// cloudflared/dns-sd children or leave orphaned renewal timers running.
async function teardown(): Promise<void> {
  cleanup(); // SIGTERM all registered child processes (cloudflared, dns-sd, avahi)
  if (renewalTimer) { clearInterval(renewalTimer); renewalTimer = null; }
  await closeActiveServers();
}

async function restartAfterError(err: Error): Promise<void> {
  const now = Date.now();
  if (now - lastRestartTime > 5 * 60 * 1000) restartCount = 0;
  lastRestartTime = now;
  restartCount++;

  if (restartCount > MAX_RESTARTS) {
    console.error(`\n[dynamoip] Too many restarts (${MAX_RESTARTS}). Exiting.\n`);
    process.exit(1);
  }

  const delay = Math.min(BASE_DELAY_MS * (2 ** (restartCount - 1)), 30_000);
  console.error(`\n[dynamoip] Unexpected error: ${err.message}`);
  console.error(`[dynamoip] Restarting in ${delay / 1000}s (attempt ${restartCount}/${MAX_RESTARTS})...\n`);

  await teardown();
  await new Promise(r => setTimeout(r, delay));
  run();
}

// Ctrl+C / SIGTERM: drain the proxy and stop the renewal timer before cleanup.ts
// reaps cloudflared and exits.
onExit(async () => {
  if (renewalTimer) { clearInterval(renewalTimer); renewalTimer = null; }
  await closeActiveServers();
});

process.on('uncaughtException',   (err)    => { restartAfterError(err).catch(() => process.exit(1)); });
process.on('unhandledRejection',  (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  restartAfterError(err).catch(() => process.exit(1));
});

// --- Main ---
async function main(): Promise<void> {
  const config  = loadConfig(configPath);
  const useAcme = !noSsl && !!config.baseDomain;
  const useTunnel     = useAcme && config.tunnel;
  const effectiveAcme = useAcme && !useTunnel;
  const useMkcert     = !noSsl && !useAcme && checkMkcert();

  let lanIp: string;
  try { lanIp = getLanIp(); } catch (e) { console.error((e as Error).message); process.exit(1); }

  // --port flag wins, then an explicit config `port`, then the mode default.
  const defaultPort = useTunnel ? 8080 : (useAcme || useMkcert) ? 443 : 80;
  const proxyPort   = portOverride ?? config.port ?? defaultPort;
  const bindHost    = useTunnel ? '127.0.0.1' : '0.0.0.0';

  const proto = (!useTunnel && (useAcme || useMkcert)) ? 'https' : 'http';

  const modeLabel = useTunnel
    ? `Max — Cloudflare Tunnel (${config.baseDomain})`
    : effectiveAcme
      ? `Pro — Cloudflare + Let's Encrypt (${config.baseDomain})`
      : useMkcert
        ? 'Quick — mkcert (local CA)'
        : 'HTTP';

  console.log(`\ndynamoip starting...`);
  console.log(`LAN IP : ${lanIp!}`);
  console.log(`Mode   : ${modeLabel}`);
  console.log('');

  let sslOpts: SslOptions | null = null;

  // --- Max mode: Cloudflare Tunnel ---
  if (useTunnel) {
    const { apiToken } = config.cloudflare!;
    const tunnelName = `dynamoip-${config.baseDomain}-${machineTag()}`;

    console.log('Cloudflare Tunnel:');
    const cloudflaredBin = await ensureCloudflared();
    let zoneId: string;
    let tunnelId: string;
    try {
      zoneId   = await getZoneId(apiToken, config.baseDomain!);
      const accountId = await getAccountId(apiToken, zoneId);
      const t  = await ensureTunnel(apiToken, accountId, tunnelName);
      tunnelId = t.id;
    } catch (e) {
      const hint = (e as Error).message.includes('10060') || (e as Error).message.includes('Tunnel')
        ? '\n  Add "Account: Cloudflare Tunnel: Edit" permission to your API token.'
        : '';
      console.error(`\nTunnel error: ${(e as Error).message}${hint}\n`);
      process.exit(1);
    }
    console.log('');

    console.log('DNS records (CNAME -> tunnel):');
    try {
      await upsertCnameRecords(apiToken, zoneId!, config.baseDomain!, config.domains.map(d => d.name), tunnelId!);
    } catch (e) {
      console.error(`\nCloudflare DNS error: ${(e as Error).message}\n`);
      process.exit(1);
    }
    console.log('');

    const credPath = path.join(os.homedir(), '.localmap', 'tunnels', `${tunnelId!}.json`);
    const cfgPath  = writeTunnelConfig(tunnelId!, credPath, config.domains, proxyPort, config.baseDomain!);

    console.log('Starting tunnel:');
    startTunnel(cfgPath, tunnelName, cloudflaredBin);
    console.log(`  cloudflared -> http://127.0.0.1:${proxyPort}`);
    console.log('');
  }

  // --- Pro mode: Cloudflare DNS + ACME certs ---
  if (effectiveAcme) {
    const { apiToken, email } = config.cloudflare!;
    let zoneId: string;

    console.log('DNS records (Cloudflare):');
    try {
      zoneId = await getZoneId(apiToken, config.baseDomain!);
      await upsertARecords(apiToken, zoneId, config.baseDomain!, config.domains.map(d => d.name), lanIp!);
    } catch (e) {
      console.error(`\nCloudflare DNS error: ${(e as Error).message}\n`);
      process.exit(1);
    }
    console.log('');

    console.log("Certificates (Let's Encrypt):");
    try {
      const { certFile, keyFile } = await obtainCert(config.baseDomain!, apiToken, email);
      sslOpts = { certFile, keyFile, redirectPort: 80, baseDomain: config.baseDomain! };
    } catch (e) {
      console.error(`\nCertificate error: ${(e as Error).message}\n`);
      process.exit(1);
    }
    console.log('');
  }

  // --- Quick mode: mkcert ---
  if (useMkcert) {
    console.log('Certificates (mkcert):');
    const certsDir = path.join(process.cwd(), 'certs');
    try {
      const { certFile, keyFile } = generateCerts(config.domains, certsDir);
      const caCertPath = getCaCertPath();
      sslOpts = { certFile, keyFile, redirectPort: 80, ...(caCertPath ? { caCertPath } : {}) };
      if (caCertPath) {
        console.log(`  CA certificate: ${caCertPath}`);
        console.log(`  Trust other devices: open http://${lanIp!}/ to download and install it.`);
      }
    } catch (e) {
      console.error(`\nCert error: ${(e as Error).message}\n`);
      process.exit(1);
    }
    console.log('');
  }

  // --- mDNS (Quick mode only) ---
  if (!useAcme) {
    console.log('Registering mDNS (.local):');
    registerAll(config.domains, proxyPort, lanIp!, !!sslOpts);
    console.log('');
  }

  // --- Proxy ---
  console.log('Starting proxy:');
  const { server, redirectServer } = startProxy(config.domains, proxyPort, sslOpts, bindHost, config.baseDomain);
  activeServers = [server, redirectServer].filter((s): s is http.Server | https.Server => s !== null);

  // Background cert renewal for Pro mode
  if (effectiveAcme) {
    renewalTimer = scheduleRenewal(
      config.baseDomain!,
      config.cloudflare!.apiToken,
      config.cloudflare!.email,
      server instanceof https.Server ? server : null,
    );
  }

  // --- Ready output ---
  console.log('');
  console.log('Ready:');
  console.log('');

  const isPublic     = useTunnel;
  const label        = isPublic ? '[PUBLIC]' : '[LAN]   ';
  const domainSuffix = useAcme ? `.${config.baseDomain}` : '.local';
  const readyProto   = useTunnel ? 'https' : proto;

  for (const { name } of config.domains) {
    console.log(`  ${label}  ${readyProto}://${name}${domainSuffix}`);
  }

  console.log('');

  if (isPublic) {
    console.log('  Live on the internet — accessible from anywhere.');
    console.log('  Anyone with the URL can reach these services.');
  } else {
    console.log('  Accessible from devices on this network only.');
  }

  console.log('\nPress Ctrl+C to stop.\n');
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (e) {
    await restartAfterError(e as Error);
  }
}

run();

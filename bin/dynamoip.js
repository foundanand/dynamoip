#!/usr/bin/env node
'use strict';

const path = require('path');
const os   = require('os');
const { loadConfig }    = require('../src/config');
const { getLanIp }      = require('../src/ip');
const { registerAll }   = require('../src/mdns');
const { startProxy }    = require('../src/proxy');
const { obtainCert, scheduleRenewal } = require('../src/acme');
const { upsertARecords, upsertCnameRecords, getZoneId } = require('../src/cloudflare');
const { checkMkcert, generateCerts, getCaCertPath } = require('../src/certs');
const { ensureCloudflared, getAccountId, ensureTunnel, writeTunnelConfig, startTunnel } = require('../src/tunnel');

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

let configPath  = './dynamoip.config.json';
let portOverride = null;

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
const MAX_RESTARTS = 5;
const BASE_DELAY_MS = 2000;
let restartCount = 0;
let lastRestartTime = 0;
let activeServers = [];

function closeActiveServers() {
  const toClose = activeServers.splice(0);
  return Promise.all(
    toClose.map(s => new Promise(resolve => s.close(resolve)))
  );
}

async function restartAfterError(err) {
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

  await closeActiveServers();
  await new Promise(r => setTimeout(r, delay));
  run();
}

process.on('uncaughtException', (err) => {
  restartAfterError(err).catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  restartAfterError(err).catch(() => process.exit(1));
});

// --- Main (async to support await) ---
async function main() {
  const config  = loadConfig(configPath);
  const useAcme = !noSsl && !!config.baseDomain;
  const useTunnel   = useAcme && config.tunnel;   // Max mode
  const effectiveAcme = useAcme && !useTunnel;    // Pro mode (ACME only, no tunnel)
  const useMkcert = !noSsl && !useAcme && checkMkcert();

  let lanIp;
  try { lanIp = getLanIp(); } catch (e) { console.error(e.message); process.exit(1); }

  // Max mode: proxy runs on localhost HTTP (cloudflared handles exposure)
  // Pro/Quick: proxy on 0.0.0.0 with SSL
  const defaultPort = useTunnel ? 8080 : (useAcme || useMkcert) ? 443 : (config.port || 80);
  const proxyPort   = portOverride ?? defaultPort;
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
  console.log(`LAN IP : ${lanIp}`);
  console.log(`Mode   : ${modeLabel}`);
  console.log('');

  let sslOpts = null;

  // --- Max mode: Cloudflare Tunnel ---
  if (useTunnel) {
    const { apiToken } = config.cloudflare;
    const tunnelName = `dynamoip-${config.baseDomain}`;

    console.log('Cloudflare Tunnel:');
    const cloudflaredBin = await ensureCloudflared();
    let zoneId, tunnelId;
    try {
      zoneId = await getZoneId(apiToken, config.baseDomain);
      const accountId = await getAccountId(apiToken, zoneId);
      const t = await ensureTunnel(apiToken, accountId, tunnelName);
      tunnelId = t.id;
    } catch (e) {
      const hint = e.message.includes('10060') || e.message.includes('Tunnel')
        ? '\n  Add "Account: Cloudflare Tunnel: Edit" permission to your API token.'
        : '';
      console.error(`\nTunnel error: ${e.message}${hint}\n`);
      process.exit(1);
    }
    console.log('');

    console.log('DNS records (CNAME -> tunnel):');
    try {
      await upsertCnameRecords(apiToken, zoneId, config.baseDomain, config.domains.map(d => d.name), tunnelId);
    } catch (e) {
      console.error(`\nCloudflare DNS error: ${e.message}\n`);
      process.exit(1);
    }
    console.log('');

    const credPath  = path.join(os.homedir(), '.localmap', 'tunnels', `${tunnelId}.json`);
    const cfgPath   = writeTunnelConfig(tunnelId, credPath, config.domains, proxyPort, config.baseDomain);

    console.log('Starting tunnel:');
    startTunnel(cfgPath, tunnelName, cloudflaredBin);
    console.log(`  cloudflared -> http://127.0.0.1:${proxyPort}`);
    console.log('');
  }

  // --- Pro mode: Cloudflare DNS + ACME certs ---
  if (effectiveAcme) {
    const { apiToken, email } = config.cloudflare;
    let zoneId;

    console.log('DNS records (Cloudflare):');
    try {
      zoneId = await getZoneId(apiToken, config.baseDomain);
      await upsertARecords(apiToken, zoneId, config.baseDomain, config.domains.map(d => d.name), lanIp);
    } catch (e) {
      console.error(`\nCloudflare DNS error: ${e.message}\n`);
      process.exit(1);
    }
    console.log('');

    console.log('Certificates (Let\'s Encrypt):');
    try {
      const { certFile, keyFile } = await obtainCert(config.baseDomain, apiToken, email);
      sslOpts = { certFile, keyFile, redirectPort: 80, baseDomain: config.baseDomain };
    } catch (e) {
      console.error(`\nCertificate error: ${e.message}\n`);
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
      sslOpts = { certFile, keyFile, redirectPort: 80, caCertPath };
    } catch (e) {
      console.error(`\nCert error: ${e.message}\n`);
      process.exit(1);
    }
    console.log('');
  }

  // --- mDNS (Quick mode only) ---
  if (!useAcme) {
    console.log('Registering mDNS (.local):');
    registerAll(config.domains, proxyPort, lanIp, !!sslOpts);
    console.log('');
  }

  // --- Proxy ---
  console.log('Starting proxy:');
  const { server, redirectServer } = startProxy(config.domains, proxyPort, sslOpts, bindHost, config.baseDomain);
  activeServers = [server, redirectServer].filter(Boolean);

  // Background cert renewal for Pro mode
  if (effectiveAcme) {
    scheduleRenewal(config.baseDomain, config.cloudflare.apiToken, config.cloudflare.email, server);
  }

  // --- Ready output ---
  console.log('');
  console.log('Ready:');
  console.log('');

  const isPublic = useTunnel;
  const label    = isPublic ? '[PUBLIC]' : '[LAN]   ';
  const domainSuffix = useAcme ? `.${config.baseDomain}` : '.local';
  const readyProto   = useTunnel ? 'https' : proto;

  config.domains.forEach(({ name }) => {
    console.log(`  ${label}  ${readyProto}://${name}${domainSuffix}`);
  });

  console.log('');

  if (isPublic) {
    console.log('  Live on the internet — accessible from anywhere.');
    console.log('  Anyone with the URL can reach these services.');
  } else {
    console.log('  Accessible from devices on this network only.');
  }

  console.log('\nPress Ctrl+C to stop.\n');
}

async function run() {
  try {
    await main();
  } catch (e) {
    await restartAfterError(e);
  }
}

run();

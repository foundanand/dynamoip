'use strict';

const { spawn } = require('child_process');
const { register, registerCallback } = require('./cleanup');
const { commandExists } = require('./utils');

function spawnDnsSd(name, args) {
  const cp = spawn('dns-sd', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  cp.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[dns-sd:${name}] ${msg}`);
  });
  cp.on('exit', (code, signal) => {
    if (signal !== 'SIGTERM') {
      console.error(`[dns-sd:${name}] exited unexpectedly (code=${code}), retrying in 3s...`);
      setTimeout(() => spawnDnsSd(name, args), 3000);
    }
  });
  register(cp);
  return cp;
}

function registerMdnsMac(domains, proxyPort, lanIp, ssl) {
  if (!commandExists('dns-sd')) {
    console.error('dns-sd not found. This tool requires macOS with dns-sd (built-in).');
    process.exit(1);
  }

  const serviceType = ssl ? '_https._tcp' : '_http._tcp';

  for (const { name, targetPort } of domains) {
    const hostname = `${name}.local`;
    // dns-sd -P: register a proxy service with a custom hostname and IP
    // This advertises the service AND registers the A record for hostname.local
    const args = ['-P', name, serviceType, 'local', String(proxyPort), hostname, lanIp, `port=${targetPort}`];
    spawnDnsSd(name, args);
    console.log(`  ${hostname} -> localhost:${targetPort}  [${lanIp}:${proxyPort}]`);
  }
}

function registerMdnsLinux(domains, proxyPort, lanIp, ssl) {
  if (!commandExists('avahi-publish')) {
    console.error('avahi-publish not found. Install with: sudo apt install avahi-utils');
    process.exit(1);
  }

  for (const { name, targetPort } of domains) {
    const hostname = `${name}.local`;

    // Register the hostname A record
    const addrProc = spawn('avahi-publish-address', ['-R', hostname, lanIp], { stdio: ['ignore', 'ignore', 'pipe'] });
    addrProc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error(`[avahi-addr:${name}] ${msg}`);
    });
    register(addrProc);

    // Register the service (so it appears in service browsers)
    const serviceType = ssl ? '_https._tcp' : '_http._tcp';
    const svcProc = spawn('avahi-publish-service', [name, serviceType, String(proxyPort)], { stdio: ['ignore', 'ignore', 'pipe'] });
    svcProc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error(`[avahi-svc:${name}] ${msg}`);
    });
    register(svcProc);

    console.log(`  ${hostname} -> localhost:${targetPort}  [${lanIp}:${proxyPort}]`);
  }
}

function registerMdnsWindows(domains, proxyPort, lanIp, ssl) {
  const multicastDns = require('multicast-dns');
  const mdns = multicastDns();

  const serviceType = ssl ? '_https._tcp.local' : '_http._tcp.local';

  // Build lookup tables for fast query answering
  const aRecords   = new Map();  // hostname.local -> lanIp
  const srvRecords = new Map();  // name._type.local -> { port, target }

  for (const { name, targetPort } of domains) {
    const hostname = `${name}.local`;
    aRecords.set(hostname, lanIp);
    srvRecords.set(`${name}.${serviceType}`, { port: proxyPort, target: hostname });
  }

  mdns.on('query', (query) => {
    const answers = [];

    for (const question of query.questions) {
      const qname = question.name.toLowerCase();

      if (question.type === 'A' || question.type === 'ANY') {
        if (aRecords.has(qname)) {
          answers.push({ name: qname, type: 'A', ttl: 120, data: aRecords.get(qname) });
        }
      }

      if (question.type === 'SRV' || question.type === 'ANY') {
        const srvEntry = srvRecords.get(qname);
        if (srvEntry) {
          answers.push({
            name: qname,
            type: 'SRV',
            ttl: 120,
            data: { priority: 0, weight: 0, port: srvEntry.port, target: srvEntry.target },
          });
        }
      }

      if (question.type === 'PTR' || question.type === 'ANY') {
        if (qname === serviceType) {
          for (const [srvName] of srvRecords) {
            answers.push({ name: serviceType, type: 'PTR', ttl: 120, data: srvName });
          }
        }
      }
    }

    if (answers.length > 0) {
      mdns.respond({ answers }, (err) => {
        if (err) console.error(`[mdns:windows] respond error: ${err.message}`);
      });
    }
  });

  mdns.on('error', (err) => {
    console.error(`[mdns:windows] ${err.message}`);
  });

  // Register teardown so Ctrl+C destroys the UDP socket cleanly
  registerCallback(() => mdns.destroy());

  for (const { name, targetPort } of domains) {
    console.log(`  ${name}.local -> localhost:${targetPort}  [${lanIp}:${proxyPort}]`);
  }
}

function registerAll(domains, proxyPort, lanIp, ssl) {
  if (process.platform === 'darwin') {
    registerMdnsMac(domains, proxyPort, lanIp, ssl);
  } else if (process.platform === 'linux') {
    registerMdnsLinux(domains, proxyPort, lanIp, ssl);
  } else if (process.platform === 'win32') {
    registerMdnsWindows(domains, proxyPort, lanIp, ssl);
  } else {
    console.error(`Unsupported platform: ${process.platform}. Only macOS, Linux, and Windows are supported.`);
    process.exit(1);
  }
}

module.exports = { registerAll };

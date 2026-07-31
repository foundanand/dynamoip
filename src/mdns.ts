import { spawn, spawnSync } from 'child_process';
import { register, isShuttingDown } from './cleanup';
import type { DomainEntry } from './types';

function checkCommand(cmd: string): boolean {
  const r = spawnSync('which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

function spawnDnsSd(name: string, args: string[]): void {
  const cp = spawn('dns-sd', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  cp.stderr.on('data', (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[dns-sd:${name}] ${msg}`);
  });
  cp.on('exit', (code, signal) => {
    if (signal !== 'SIGTERM' && !isShuttingDown()) {
      console.error(`[dns-sd:${name}] exited unexpectedly (code=${code}), retrying in 3s...`);
      setTimeout(() => spawnDnsSd(name, args), 3000).unref();
    }
  });
  register(cp);
}

function registerMdnsMac(domains: DomainEntry[], proxyPort: number, lanIp: string, ssl: boolean): void {
  if (!checkCommand('dns-sd')) {
    console.error('dns-sd not found. This tool requires macOS with dns-sd (built-in).');
    process.exit(1);
  }

  const serviceType = ssl ? '_https._tcp' : '_http._tcp';

  for (const { name, targetPort } of domains) {
    const hostname = `${name}.local`;
    const args = ['-P', name, serviceType, 'local', String(proxyPort), hostname, lanIp, `port=${targetPort}`];
    spawnDnsSd(name, args);
    console.log(`  ${hostname} -> localhost:${targetPort}  [${lanIp}:${proxyPort}]`);
  }
}

function registerMdnsLinux(domains: DomainEntry[], proxyPort: number, lanIp: string, ssl: boolean): void {
  if (!checkCommand('avahi-publish')) {
    console.error('avahi-publish not found. Install with: sudo apt install avahi-utils');
    process.exit(1);
  }

  const serviceType = ssl ? '_https._tcp' : '_http._tcp';

  for (const { name, targetPort } of domains) {
    const hostname = `${name}.local`;

    const addrProc = spawn('avahi-publish-address', ['-R', hostname, lanIp], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    addrProc.stderr.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error(`[avahi-addr:${name}] ${msg}`);
    });
    register(addrProc);

    const svcProc = spawn('avahi-publish-service', [name, serviceType, String(proxyPort)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    svcProc.stderr.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error(`[avahi-svc:${name}] ${msg}`);
    });
    register(svcProc);

    console.log(`  ${hostname} -> localhost:${targetPort}  [${lanIp}:${proxyPort}]`);
  }
}

export function registerAll(domains: DomainEntry[], proxyPort: number, lanIp: string, ssl: boolean): void {
  if (process.platform === 'darwin') {
    registerMdnsMac(domains, proxyPort, lanIp, ssl);
  } else if (process.platform === 'linux') {
    registerMdnsLinux(domains, proxyPort, lanIp, ssl);
  } else {
    console.error(`Unsupported platform: ${process.platform}. Only macOS and Linux are supported.`);
    process.exit(1);
  }
}

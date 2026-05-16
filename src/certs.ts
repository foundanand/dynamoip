import { spawnSync, SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { DomainEntry } from './types';

type MkcertRunner = (args: string[], opts?: { stdio?: 'inherit' | 'pipe' | 'ignore' }) => SpawnSyncReturns<Buffer>;

// When the process is running as root via sudo, mkcert must run as the original
// user so the CA gets installed into *their* keychain (what browsers trust),
// not into root's keychain (which browsers ignore).
function getMkcertRunner(): MkcertRunner {
  const sudoUser = process.env.SUDO_USER;
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  if (sudoUser && isRoot) {
    let mkcertPath: string | undefined;
    const r = spawnSync('sudo', ['-u', sudoUser, 'which', 'mkcert'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status === 0) mkcertPath = r.stdout.trim();

    // Fallback to common Homebrew locations
    if (!mkcertPath) {
      for (const p of ['/opt/homebrew/bin/mkcert', '/usr/local/bin/mkcert']) {
        if (fs.existsSync(p)) { mkcertPath = p; break; }
      }
    }

    if (mkcertPath) {
      const resolvedPath = mkcertPath;
      return (args, opts) =>
        spawnSync('sudo', ['-u', sudoUser, resolvedPath, ...args], { stdio: 'inherit', ...opts }) as SpawnSyncReturns<Buffer>;
    }

    console.warn("  Warning: could not find mkcert in the original user's PATH. CA may install to root keychain.");
  }

  return (args, opts) => spawnSync('mkcert', args, { stdio: 'inherit', ...opts }) as SpawnSyncReturns<Buffer>;
}

function checkMkcert(): boolean {
  const sudoUser = process.env.SUDO_USER;
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  if (sudoUser && isRoot) {
    const r = spawnSync('sudo', ['-u', sudoUser, 'which', 'mkcert'], { stdio: 'ignore' });
    if (r.status === 0) return true;
    return ['/opt/homebrew/bin/mkcert', '/usr/local/bin/mkcert'].some(p => fs.existsSync(p));
  }

  const r = spawnSync('which', ['mkcert'], { stdio: 'ignore' });
  return r.status === 0;
}

export { checkMkcert };

export function generateCerts(
  domains: DomainEntry[],
  certsDir: string,
): { certFile: string; keyFile: string } {
  if (!checkMkcert()) {
    console.error('\nmkcert not found. Install it to enable HTTPS:');
    console.error('  brew install mkcert   (macOS)');
    console.error('  apt install mkcert    (Linux)');
    console.error('\nOr run with --no-ssl to use HTTP instead.\n');
    process.exit(1);
  }

  if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

  const certFile  = path.join(certsDir, 'dynamoip.pem');
  const keyFile   = path.join(certsDir, 'dynamoip-key.pem');
  const stampFile = path.join(certsDir, '.domains');

  const currentStamp  = domains.map(d => `${d.name}.local`).sort().join(',');
  const existingStamp = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';

  if (fs.existsSync(certFile) && fs.existsSync(keyFile) && currentStamp === existingStamp) {
    console.log('  Using existing certificates (delete ./certs to regenerate)');
    return { certFile, keyFile };
  }

  const run = getMkcertRunner();

  console.log('  Installing local CA into user trust store (may prompt for password)...');
  const install = run(['-install']);
  if (install.status !== 0) {
    console.error('  CA installation failed.');
    process.exit(1);
  }

  const hostnames = domains.map(d => `${d.name}.local`);
  console.log(`  Generating certificate for: ${hostnames.join(', ')}`);

  const gen = run(['-cert-file', certFile, '-key-file', keyFile, ...hostnames]);
  if (gen.status !== 0) {
    console.error('  Certificate generation failed.');
    process.exit(1);
  }

  const sudoUser = process.env.SUDO_USER;
  if (sudoUser) {
    try {
      spawnSync('chown', [sudoUser, certFile, keyFile, certsDir], { stdio: 'ignore' });
    } catch (_) {}
  }

  fs.writeFileSync(stampFile, currentStamp);
  return { certFile, keyFile };
}

export function getCaRootPath(): string | null {
  const run = getMkcertRunner();
  try {
    const result = run(['-CAROOT'], { stdio: 'pipe' });
    return result.stdout ? result.stdout.toString().trim() : null;
  } catch (_) {
    return null;
  }
}

export function getCaCertPath(): string | null {
  const root = getCaRootPath();
  if (!root) return null;
  const p = path.join(root, 'rootCA.pem');
  return fs.existsSync(p) ? p : null;
}

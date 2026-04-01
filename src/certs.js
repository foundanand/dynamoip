'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { commandExists } = require('./utils');

// When the process is running as root via sudo, mkcert must run as the original
// user so the CA gets installed into *their* keychain (what browsers trust),
// not into root's keychain (which browsers ignore).
function getMkcertRunner() {
  const sudoUser = process.env.SUDO_USER;
  const isRoot   = typeof process.getuid === 'function' && process.getuid() === 0;

  if (sudoUser && isRoot) {
    // Find mkcert in the original user's PATH
    let mkcertPath;
    const r = spawnSync('sudo', ['-u', sudoUser, 'which', 'mkcert'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0) mkcertPath = r.stdout.trim();

    // Fallback to common Homebrew locations
    if (!mkcertPath) {
      for (const p of ['/opt/homebrew/bin/mkcert', '/usr/local/bin/mkcert']) {
        if (fs.existsSync(p)) { mkcertPath = p; break; }
      }
    }

    if (mkcertPath) {
      return (args, opts) => spawnSync('sudo', ['-u', sudoUser, mkcertPath, ...args], { stdio: 'inherit', ...opts });
    }

    console.warn('  Warning: could not find mkcert in the original user\'s PATH. CA may install to root keychain.');
  }

  return (args, opts) => spawnSync('mkcert', args, { stdio: 'inherit', ...opts });
}

function checkMkcert() {
  const sudoUser = process.env.SUDO_USER;
  const isRoot   = typeof process.getuid === 'function' && process.getuid() === 0;

  if (sudoUser && isRoot) {
    // Check as the original user
    const r = spawnSync('sudo', ['-u', sudoUser, 'which', 'mkcert'], { stdio: 'ignore' });
    if (r.status === 0) return true;
    // Also try known paths
    return ['/opt/homebrew/bin/mkcert', '/usr/local/bin/mkcert'].some(p => fs.existsSync(p));
  }

  return commandExists('mkcert');
}

function generateCerts(domains, certsDir) {
  if (!checkMkcert()) {
    console.error('\nmkcert not found. Install it to enable HTTPS:');
    console.error('  brew install mkcert          (macOS)');
    console.error('  apt install mkcert           (Linux)');
    console.error('  choco install mkcert         (Windows, Chocolatey)');
    console.error('  scoop install mkcert         (Windows, Scoop)');
    console.error('\nOr run with --no-ssl to use HTTP instead.\n');
    process.exit(1);
  }

  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true });
  }

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

  // Install CA into the *user's* trust store so browsers trust it
  console.log('  Installing local CA into user trust store (may prompt for password)...');
  const install = run(['-install']);
  if (install.status !== 0) {
    console.error('  CA installation failed.');
    process.exit(1);
  }

  // Generate cert covering all .local hostnames
  const hostnames = domains.map(d => `${d.name}.local`);
  console.log(`  Generating certificate for: ${hostnames.join(', ')}`);

  const gen = run(['-cert-file', certFile, '-key-file', keyFile, ...hostnames]);
  if (gen.status !== 0) {
    console.error('  Certificate generation failed.');
    process.exit(1);
  }

  // Make cert files readable by the original user (not just root) — Unix only
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && process.platform !== 'win32') {
    try {
      spawnSync('chown', [sudoUser, certFile, keyFile, certsDir], { stdio: 'ignore' });
    } catch (_) {}
  }

  fs.writeFileSync(stampFile, currentStamp);
  return { certFile, keyFile };
}

function getCaRootPath() {
  const run = getMkcertRunner();
  try {
    const result = run(['-CAROOT'], { stdio: 'pipe' });
    return result.stdout ? result.stdout.toString().trim() : null;
  } catch (_) {
    return null;
  }
}

function getCaCertPath() {
  const root = getCaRootPath();
  if (!root) return null;
  const p = path.join(root, 'rootCA.pem');
  return fs.existsSync(p) ? p : null;
}

module.exports = { checkMkcert, generateCerts, getCaRootPath, getCaCertPath };

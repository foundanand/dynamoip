'use strict';

const children  = new Set();
const callbacks = new Set();

function register(cp) {
  children.add(cp);
  cp.on('exit', () => children.delete(cp));
}

// Register an arbitrary shutdown callback (e.g. mdns.destroy() on Windows)
function registerCallback(fn) {
  callbacks.add(fn);
}

function cleanup() {
  for (const cp of children) {
    try { cp.kill('SIGTERM'); } catch (_) {}
  }
  children.clear();

  for (const fn of callbacks) {
    try { fn(); } catch (_) {}
  }
  callbacks.clear();
}

process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

module.exports = { register, registerCallback, cleanup };

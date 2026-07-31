import type { ChildProcess } from 'child_process';

const children = new Set<ChildProcess>();
const exitTasks: Array<() => Promise<void> | void> = [];

// How long a child gets to exit on its own before it is SIGKILLed.
const GRACE_MS = 8000;

let shuttingDown = false;

// Child auto-restart loops must consult this — respawning cloudflared while we are
// tearing down is what strands a process holding the tunnel's connections open.
export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function register(cp: ChildProcess): void {
  children.add(cp);
  cp.on('exit', () => children.delete(cp));
}

// Teardown to run before children are reaped — closing listening sockets, clearing timers.
export function onExit(fn: () => Promise<void> | void): void {
  exitTasks.push(fn);
}

// Synchronous SIGTERM of every child, used by the restart path (which keeps running).
export function cleanup(): void {
  for (const cp of children) {
    try { cp.kill('SIGTERM'); } catch (_) {}
  }
  children.clear();
}

function alive(cp: ChildProcess): boolean {
  return cp.exitCode === null && cp.signalCode === null;
}

// Resolve once every child has exited, SIGKILLing whatever is still up at the deadline.
// Exiting immediately after SIGTERM (the old behaviour) can leave cloudflared running:
// it then keeps the tunnel's connections open, and the next startup cannot reuse or
// delete that tunnel.
function waitForChildren(kids: ChildProcess[]): Promise<void> {
  const pending = kids.filter(alive);
  if (!pending.length) return Promise.resolve();

  return new Promise((resolve) => {
    let left = pending.length;
    const timer = setTimeout(() => {
      for (const cp of pending) {
        if (alive(cp)) {
          console.log('  a child process did not stop in time — forcing it');
          try { cp.kill('SIGKILL'); } catch (_) {}
        }
      }
      resolve();
    }, GRACE_MS);

    for (const cp of pending) {
      cp.once('exit', () => {
        if (--left === 0) { clearTimeout(timer); resolve(); }
      });
    }
  });
}

export async function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${reason} — shutting down...`);

  // Signal children first so cloudflared starts draining its edge connections while
  // we close the local listeners, rather than after.
  const kids = [...children];
  for (const cp of kids) {
    try { cp.kill('SIGTERM'); } catch (_) {}
  }

  for (const fn of exitTasks) {
    try { await fn(); } catch (_) {}
  }

  await waitForChildren(kids);
  children.clear();

  console.log('Stopped.\n');
  process.exit(code);
}

let signalCount = 0;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    // Second Ctrl+C means "stop waiting" — kill everything and go.
    if (++signalCount > 1) {
      for (const cp of children) {
        try { cp.kill('SIGKILL'); } catch (_) {}
      }
      console.log('\nForced.\n');
      process.exit(130);
    }
    const reason = sig === 'SIGINT' ? 'Interrupted' : `Received ${sig}`;
    shutdown(reason).catch(() => process.exit(1));
  });
}

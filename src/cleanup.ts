import type { ChildProcess } from 'child_process';

const children = new Set<ChildProcess>();

export function register(cp: ChildProcess): void {
  children.add(cp);
  cp.on('exit', () => children.delete(cp));
}

export function cleanup(): void {
  for (const cp of children) {
    try { cp.kill('SIGTERM'); } catch (_) {}
  }
  children.clear();
}

process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

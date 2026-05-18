// cleanup.js — child process lifecycle management
//
// register: adds a ChildProcess to an in-memory Set and removes it automatically
//   when the process emits 'exit', so stale handles don't accumulate.
//
// cleanup: sends SIGTERM to every currently-tracked child. Called on SIGINT/SIGTERM
//   so cloudflared and dns-sd subprocesses are torn down on Ctrl+C.
//
// The module keeps a module-level Set, so vi.resetModules() + dynamic import is used
// to get a fresh Set for each test and avoid cross-test state leakage.

describe('cleanup', () => {
  // Use dynamic import with resetModules to get fresh module state per test
  // (module-level `children` Set would otherwise leak between tests)

  it('cleanup sends SIGTERM to all registered child processes', async () => {
    vi.resetModules();
    const { register, cleanup } = await import('../../src/cleanup.js');

    const mockCp = { kill: vi.fn(), on: vi.fn() };
    register(mockCp);
    cleanup();

    expect(mockCp.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cleanup does nothing when no processes are registered', async () => {
    vi.resetModules();
    const { cleanup } = await import('../../src/cleanup.js');
    expect(() => cleanup()).not.toThrow();
  });

  it('child process is removed from tracking after it exits', async () => {
    vi.resetModules();
    const { register, cleanup } = await import('../../src/cleanup.js');

    let exitCallback;
    const mockCp = {
      kill: vi.fn(),
      on: vi.fn((event, cb) => { if (event === 'exit') exitCallback = cb; }),
    };

    register(mockCp);
    exitCallback(); // simulate the process exiting naturally
    cleanup();     // should not kill it — it's already gone

    expect(mockCp.kill).not.toHaveBeenCalled();
  });

  it('register tracks multiple child processes', async () => {
    vi.resetModules();
    const { register, cleanup } = await import('../../src/cleanup.js');

    const cp1 = { kill: vi.fn(), on: vi.fn() };
    const cp2 = { kill: vi.fn(), on: vi.fn() };
    register(cp1);
    register(cp2);
    cleanup();

    expect(cp1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(cp2.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

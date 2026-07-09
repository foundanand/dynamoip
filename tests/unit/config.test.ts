// config.js — config file loading and validation
//
// loadEnv: reads a .env file from the given directory and injects KEY=VALUE pairs
//   into process.env, skipping comments, blanks, and keys already set.
//   Strips surrounding single or double quotes from values.
//
// loadConfig: reads and validates dynamoip.config.json. Calls process.exit(1) for
//   any invalid input (missing file, bad JSON, bad port, invalid domain names,
//   duplicates, missing CF_API_TOKEN when baseDomain is set, tunnel without baseDomain).
//   On success returns { port, domains, baseDomain, cloudflare, tunnel }.
//
// Error-path tests mock process.exit(1) to throw instead of killing the test process.
// File I/O tests write configs to a temp directory that is cleaned up after each test.

import os from 'os';
import path from 'path';
import fs from 'fs';
import { loadConfig, loadEnv } from '../../src/config.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dynamoip-test-'));
}

function writeConfig(dir, content) {
  const configPath = path.join(dir, 'dynamoip.config.json');
  fs.writeFileSync(configPath, JSON.stringify(content));
  return configPath;
}

describe('loadEnv', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('parses KEY=VALUE pairs', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'DTEST_A=hello\n');
    delete process.env.DTEST_A;
    loadEnv(tmpDir);
    expect(process.env.DTEST_A).toBe('hello');
    delete process.env.DTEST_A;
  });

  it('strips double quotes from values', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'DTEST_B="quoted value"\n');
    delete process.env.DTEST_B;
    loadEnv(tmpDir);
    expect(process.env.DTEST_B).toBe('quoted value');
    delete process.env.DTEST_B;
  });

  it('strips single quotes from values', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), "DTEST_C='single quoted'\n");
    delete process.env.DTEST_C;
    loadEnv(tmpDir);
    expect(process.env.DTEST_C).toBe('single quoted');
    delete process.env.DTEST_C;
  });

  it('ignores comment lines', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '# this is a comment\nDTEST_D=yes\n');
    delete process.env.DTEST_D;
    loadEnv(tmpDir);
    expect(process.env.DTEST_D).toBe('yes');
    delete process.env.DTEST_D;
  });

  it('ignores blank lines', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '\n\nDTEST_E=value\n\n');
    delete process.env.DTEST_E;
    loadEnv(tmpDir);
    expect(process.env.DTEST_E).toBe('value');
    delete process.env.DTEST_E;
  });

  it('does not override an already-set env var', () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'DTEST_F=from_file\n');
    process.env.DTEST_F = 'already_set';
    loadEnv(tmpDir);
    expect(process.env.DTEST_F).toBe('already_set');
    delete process.env.DTEST_F;
  });

  it('does nothing when .env file does not exist', () => {
    expect(() => loadEnv(tmpDir)).not.toThrow();
  });
});

describe('loadConfig', () => {
  let tmpDir;
  let exitSpy;
  let savedCfToken;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    savedCfToken = process.env.CF_API_TOKEN;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedCfToken === undefined) delete process.env.CF_API_TOKEN;
    else process.env.CF_API_TOKEN = savedCfToken;
  });

  // --- Error cases ---

  it('exits when config file does not exist', () => {
    expect(() => loadConfig('/nonexistent/dynamoip.config.json')).toThrow('process.exit(1)');
  });

  it('exits on malformed JSON', () => {
    const configPath = path.join(tmpDir, 'dynamoip.config.json');
    fs.writeFileSync(configPath, '{ bad json }');
    expect(() => loadConfig(configPath)).toThrow('process.exit(1)');
  });

  it('exits on port below 1', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { port: 0, domains: { api: 3000 } }))).toThrow('process.exit(1)');
  });

  it('exits on port above 65535', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { port: 99999, domains: { api: 3000 } }))).toThrow('process.exit(1)');
  });

  it('exits when domains field is missing', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { port: 80 }))).toThrow('process.exit(1)');
  });

  it('exits when domains is an array instead of object', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { domains: [3000] }))).toThrow('process.exit(1)');
  });

  it('exits on invalid domain name containing a space', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { domains: { 'my app': 3000 } }))).toThrow('process.exit(1)');
  });

  it('exits on invalid domain name containing a dot', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { domains: { 'my.app': 3000 } }))).toThrow('process.exit(1)');
  });

  it('exits on non-integer port for a domain', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { domains: { api: 'notaport' } }))).toThrow('process.exit(1)');
  });

  it('exits on out-of-range port for a domain', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { domains: { api: 0 } }))).toThrow('process.exit(1)');
  });

  it('exits on duplicate domain names (case-insensitive)', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { domains: { api: 3000, API: 4000 } }))).toThrow('process.exit(1)');
  });

  it('exits on duplicate target ports across domains', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { domains: { api: 3000, web: 3000 } }))).toThrow('process.exit(1)');
  });

  it('exits when domains object is empty', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { domains: {} }))).toThrow('process.exit(1)');
  });

  it('exits when tunnel:true is set but baseDomain is missing', () => {
    expect(() => loadConfig(writeConfig(tmpDir, { domains: { api: 3000 }, tunnel: true }))).toThrow('process.exit(1)');
  });

  it('exits when baseDomain is set but CF_API_TOKEN is missing', () => {
    delete process.env.CF_API_TOKEN;
    expect(() => loadConfig(writeConfig(tmpDir, { domains: { api: 3000 }, baseDomain: 'myteam.dev' }))).toThrow('process.exit(1)');
  });

  // --- Success cases ---

  it('returns a valid config for Quick mode (no baseDomain)', () => {
    const config = loadConfig(writeConfig(tmpDir, { domains: { api: 3000, web: 4000 } }));
    expect(config.domains).toEqual([
      { name: 'api', targetPort: 3000 },
      { name: 'web', targetPort: 4000 },
    ]);
    expect(config.baseDomain).toBeNull();
    expect(config.cloudflare).toBeNull();
    expect(config.tunnel).toBe(false);
  });

  it('returns a valid config for Pro mode (baseDomain, no tunnel)', () => {
    process.env.CF_API_TOKEN = 'test-token';
    const config = loadConfig(writeConfig(tmpDir, { domains: { api: 3000 }, baseDomain: 'myteam.dev' }));
    expect(config.baseDomain).toBe('myteam.dev');
    expect(config.cloudflare.apiToken).toBe('test-token');
    expect(config.tunnel).toBe(false);
  });

  it('returns a valid config for Max mode (baseDomain + tunnel)', () => {
    process.env.CF_API_TOKEN = 'test-token';
    const config = loadConfig(writeConfig(tmpDir, { domains: { api: 3000 }, baseDomain: 'myteam.dev', tunnel: true }));
    expect(config.tunnel).toBe(true);
    expect(config.baseDomain).toBe('myteam.dev');
  });

  it('normalises domain names to lowercase', () => {
    const config = loadConfig(writeConfig(tmpDir, { domains: { MyApp: 3000 } }));
    expect(config.domains[0].name).toBe('myapp');
  });

  it('leaves proxy port null when not specified (bin picks the mode default)', () => {
    const config = loadConfig(writeConfig(tmpDir, { domains: { api: 3000 } }));
    expect(config.port).toBeNull();
  });

  it('respects an explicit port value', () => {
    const config = loadConfig(writeConfig(tmpDir, { port: 8080, domains: { api: 3000 } }));
    expect(config.port).toBe(8080);
  });

  it('normalises baseDomain to lowercase', () => {
    process.env.CF_API_TOKEN = 'test-token';
    const config = loadConfig(writeConfig(tmpDir, { domains: { api: 3000 }, baseDomain: 'MyTeam.Dev' }));
    expect(config.baseDomain).toBe('myteam.dev');
  });

  it('sets cloudflare.email from CF_EMAIL env var', () => {
    process.env.CF_API_TOKEN = 'test-token';
    process.env.CF_EMAIL = 'dev@example.com';
    const config = loadConfig(writeConfig(tmpDir, { domains: { api: 3000 }, baseDomain: 'myteam.dev' }));
    expect(config.cloudflare.email).toBe('dev@example.com');
    delete process.env.CF_EMAIL;
  });
});

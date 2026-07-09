// tunnel.js — Cloudflare Tunnel (cloudflared) lifecycle helpers
//
// writeTunnelConfig: generates the cloudflared config.yml at ~/.localmap/tunnels/config.yml.
//   The YAML contains the tunnel ID, credentials file path, and one ingress rule per domain
//   mapping name.baseDomain -> http://localhost:<proxyPort>, plus a catch-all 404 rule.
//   Called every startup so ingress stays in sync with the config file.
//
// Other exports (ensureCloudflared, ensureTunnel, startTunnel) spawn external processes
//   or make Cloudflare API calls and are not unit-tested here.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { writeTunnelConfig } from '../../src/tunnel.js';

// writeTunnelConfig writes to ~/.localmap/tunnels/config-<tunnelId>.yml
// We call it and verify the YAML content, then clean up
const TUNNELS_DIR = path.join(os.homedir(), '.localmap', 'tunnels');
const ymlFor = (tunnelId) => path.join(TUNNELS_DIR, `config-${tunnelId}.yml`);

describe('writeTunnelConfig', () => {
  const written = new Set();
  const write = (...args) => {
    const p = writeTunnelConfig(...args);
    written.add(p);
    return p;
  };
  afterEach(() => {
    for (const p of written) if (fs.existsSync(p)) fs.unlinkSync(p);
    written.clear();
  });

  it('returns a per-tunnel path to the written config file', () => {
    const result = write('tid-123', '/creds/tid-123.json', [{ name: 'api' }], 8080, 'myteam.dev');
    expect(result).toBe(ymlFor('tid-123'));
  });

  it('gives different tunnels different config files (no clobbering)', () => {
    const a = write('tid-a', '/creds/a.json', [{ name: 'api' }], 8080, 'a.dev');
    const b = write('tid-b', '/creds/b.json', [{ name: 'api' }], 8080, 'b.dev');
    expect(a).not.toBe(b);
    expect(fs.readFileSync(a, 'utf8')).toContain('a.dev');
    expect(fs.readFileSync(b, 'utf8')).toContain('b.dev');
  });

  it('writes tunnel ID and credentials path', () => {
    write('tid-abc', '/home/user/.localmap/tunnels/tid-abc.json', [{ name: 'api' }], 8080, 'myteam.dev');
    const content = fs.readFileSync(ymlFor('tid-abc'), 'utf8');
    expect(content).toContain('tunnel: tid-abc');
    expect(content).toContain('credentials-file: /home/user/.localmap/tunnels/tid-abc.json');
  });

  it('writes an ingress rule for each domain', () => {
    const domains = [{ name: 'api' }, { name: 'web' }];
    write('tid-xyz', '/creds.json', domains, 8080, 'myteam.dev');
    const content = fs.readFileSync(ymlFor('tid-xyz'), 'utf8');
    expect(content).toContain('hostname: api.myteam.dev');
    expect(content).toContain('hostname: web.myteam.dev');
    expect(content).toContain('service: http://localhost:8080');
  });

  it('includes a catch-all 404 rule at the end', () => {
    write('tid-xyz', '/creds.json', [{ name: 'api' }], 8080, 'myteam.dev');
    const content = fs.readFileSync(ymlFor('tid-xyz'), 'utf8');
    expect(content).toContain('http_status:404');
  });

  it('uses the proxy port in each service entry', () => {
    write('tid-xyz', '/creds.json', [{ name: 'api' }], 9090, 'myteam.dev');
    const content = fs.readFileSync(ymlFor('tid-xyz'), 'utf8');
    expect(content).toContain('service: http://localhost:9090');
    expect(content).not.toContain('localhost:8080');
  });
});

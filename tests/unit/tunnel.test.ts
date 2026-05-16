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

// writeTunnelConfig writes to ~/.localmap/tunnels/config.yml
// We call it and verify the YAML content, then clean up
const TUNNELS_DIR = path.join(os.homedir(), '.localmap', 'tunnels');
const CONFIG_YML  = path.join(TUNNELS_DIR, 'config.yml');

describe('writeTunnelConfig', () => {
  afterEach(() => {
    if (fs.existsSync(CONFIG_YML)) fs.unlinkSync(CONFIG_YML);
  });

  it('returns the path to the written config file', () => {
    const result = writeTunnelConfig('tid-123', '/creds/tid-123.json', [{ name: 'api' }], 8080, 'myteam.dev');
    expect(result).toBe(CONFIG_YML);
  });

  it('writes tunnel ID and credentials path', () => {
    writeTunnelConfig('tid-abc', '/home/user/.localmap/tunnels/tid-abc.json', [{ name: 'api' }], 8080, 'myteam.dev');
    const content = fs.readFileSync(CONFIG_YML, 'utf8');
    expect(content).toContain('tunnel: tid-abc');
    expect(content).toContain('credentials-file: /home/user/.localmap/tunnels/tid-abc.json');
  });

  it('writes an ingress rule for each domain', () => {
    const domains = [{ name: 'api' }, { name: 'web' }];
    writeTunnelConfig('tid-xyz', '/creds.json', domains, 8080, 'myteam.dev');
    const content = fs.readFileSync(CONFIG_YML, 'utf8');
    expect(content).toContain('hostname: api.myteam.dev');
    expect(content).toContain('hostname: web.myteam.dev');
    expect(content).toContain('service: http://localhost:8080');
  });

  it('includes a catch-all 404 rule at the end', () => {
    writeTunnelConfig('tid-xyz', '/creds.json', [{ name: 'api' }], 8080, 'myteam.dev');
    const content = fs.readFileSync(CONFIG_YML, 'utf8');
    expect(content).toContain('http_status:404');
  });

  it('uses the proxy port in each service entry', () => {
    writeTunnelConfig('tid-xyz', '/creds.json', [{ name: 'api' }], 9090, 'myteam.dev');
    const content = fs.readFileSync(CONFIG_YML, 'utf8');
    expect(content).toContain('service: http://localhost:9090');
    expect(content).not.toContain('localhost:8080');
  });
});

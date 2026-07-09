// proxy.js — host-header routing and WebSocket proxy
//
// buildRouteMap: builds a lookup Map from hostname strings to upstream targets.
//   Entries are added for name.local, bare name, and (if baseDomain given) name.baseDomain.
//   TARGET_HOST env var overrides localhost for Docker/remote targets.
//
// resolveTarget: given a raw Host header value, strips any port suffix, lowercases,
//   and looks up the target URL in the route map. Returns null if not found.
//
// buildCertPage: returns the HTML string for the CA-cert trust setup page that
//   the HTTP server serves in Quick mode (see the integration tests below for
//   the actual wiring on port 80).

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildRouteMap,
  resolveTarget,
  buildCertPage,
  createRedirectHandler,
} from '../../src/proxy.js';

describe('buildRouteMap', () => {
  const domains = [
    { name: 'api', targetPort: 3000 },
    { name: 'web', targetPort: 4000 },
  ];

  beforeEach(() => {
    delete process.env.TARGET_HOST;
  });

  it('maps name.local to localhost target', () => {
    const map = buildRouteMap(domains, null);
    expect(map.get('api.local')).toBe('http://localhost:3000');
    expect(map.get('web.local')).toBe('http://localhost:4000');
  });

  it('maps bare name to localhost target', () => {
    const map = buildRouteMap(domains, null);
    expect(map.get('api')).toBe('http://localhost:3000');
  });

  it('maps name.baseDomain when baseDomain is provided', () => {
    const map = buildRouteMap(domains, 'myteam.dev');
    expect(map.get('api.myteam.dev')).toBe('http://localhost:3000');
    expect(map.get('web.myteam.dev')).toBe('http://localhost:4000');
  });

  it('does not add baseDomain entries when baseDomain is null', () => {
    const map = buildRouteMap(domains, null);
    expect(map.get('api.myteam.dev')).toBeUndefined();
  });

  it('uses TARGET_HOST env var when set', () => {
    process.env.TARGET_HOST = '192.168.1.5';
    const map = buildRouteMap(domains, null);
    expect(map.get('api.local')).toBe('http://192.168.1.5:3000');
    expect(map.get('web.local')).toBe('http://192.168.1.5:4000');
  });

  it('produces correct number of entries (3 per domain without baseDomain)', () => {
    const map = buildRouteMap(domains, null);
    expect(map.size).toBe(4); // 2 domains × (name.local + bare) = 4
  });

  it('produces correct number of entries (3 per domain with baseDomain)', () => {
    const map = buildRouteMap(domains, 'myteam.dev');
    expect(map.size).toBe(6); // 2 domains × (name.local + bare + name.baseDomain) = 6
  });
});

describe('resolveTarget', () => {
  const map = new Map([
    ['api.local', 'http://localhost:3000'],
    ['web.myteam.dev', 'http://localhost:4000'],
  ]);

  it('resolves a known host', () => {
    expect(resolveTarget(map, 'api.local')).toBe('http://localhost:3000');
  });

  it('strips port suffix from host header', () => {
    expect(resolveTarget(map, 'api.local:443')).toBe('http://localhost:3000');
    expect(resolveTarget(map, 'web.myteam.dev:8080')).toBe('http://localhost:4000');
  });

  it('is case-insensitive', () => {
    expect(resolveTarget(map, 'API.LOCAL')).toBe('http://localhost:3000');
    expect(resolveTarget(map, 'Web.MyTeam.Dev')).toBe('http://localhost:4000');
  });

  it('returns null for unknown host', () => {
    expect(resolveTarget(map, 'unknown.local')).toBeNull();
  });

  it('returns null for empty host', () => {
    expect(resolveTarget(map, '')).toBeNull();
  });

  it('returns null for null/undefined host', () => {
    expect(resolveTarget(map, null)).toBeNull();
    expect(resolveTarget(map, undefined)).toBeNull();
  });
});

describe('buildCertPage', () => {
  const domains = [{ name: 'api', targetPort: 3000 }, { name: 'web', targetPort: 4000 }];

  it('returns a valid HTML document', () => {
    const html = buildCertPage(domains, 443);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('includes links for every domain', () => {
    const html = buildCertPage(domains, 443);
    expect(html).toContain('api.local');
    expect(html).toContain('web.local');
  });

  it('omits port suffix for port 443', () => {
    const html = buildCertPage(domains, 443);
    expect(html).not.toContain(':443');
  });

  it('includes port suffix for non-standard port', () => {
    const html = buildCertPage(domains, 8443);
    expect(html).toContain(':8443');
  });

  it('includes a CA certificate download link', () => {
    const html = buildCertPage(domains, 443);
    expect(html).toContain('dynamoip-ca.crt');
  });
});

// Integration test: boot the real HTTP redirect/trust server and drive it over a
// live socket. This is the wiring that the earlier version was missing — the CA
// cert download and trust page are exercised end-to-end here, not just in isolation.
describe('createRedirectHandler (HTTP server integration)', () => {
  const domains = [{ name: 'api', targetPort: 3000 }, { name: 'web', targetPort: 4000 }];

  // Quick mode: baseDomain null → routeMap has api.local + api (and web).
  const quickRouteMap = buildRouteMap(domains, null);
  // Pro mode: baseDomain set, no CA cert to install.
  const proRouteMap = buildRouteMap(domains, 'myteam.dev');

  let caFile;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamoip-ca-'));
    caFile = path.join(dir, 'rootCA.pem');
    fs.writeFileSync(caFile, 'FAKE-CA-CERT-BYTES\n');
  });

  afterAll(() => {
    try { fs.rmSync(path.dirname(caFile), { recursive: true, force: true }); } catch {}
  });

  // Boot an http.Server with the given handler, run `fn` against it, then close.
  async function withServer(handler, fn) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      return await fn(port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // Minimal HTTP client: returns { status, headers, body } without following redirects.
  function request(port, urlPath, host) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: host ? { host } : {} },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('Quick mode: serves the CA certificate bytes at /dynamoip-ca.crt', async () => {
    const handler = createRedirectHandler(quickRouteMap, 443, domains, caFile);
    const res = await withServer(handler, (port) => request(port, '/dynamoip-ca.crt', '192.168.1.42'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('x-x509-ca-cert');
    expect(res.headers['content-disposition']).toContain('dynamoip-ca.crt');
    expect(res.body.toString()).toContain('FAKE-CA-CERT-BYTES');
  });

  it('Quick mode: serves the trust page for an unknown host (raw LAN IP)', async () => {
    const handler = createRedirectHandler(quickRouteMap, 443, domains, caFile);
    const res = await withServer(handler, (port) => request(port, '/', '192.168.1.42'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const html = res.body.toString();
    expect(html).toContain('Trust Setup');
    expect(html).toContain('dynamoip-ca.crt');
  });

  it('redirects a known host to HTTPS', async () => {
    const handler = createRedirectHandler(quickRouteMap, 443, domains, caFile);
    const res = await withServer(handler, (port) => request(port, '/dashboard', 'api.local'));
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://api.local/dashboard');
  });

  it('includes the proxy port in the redirect when it is non-standard', async () => {
    const handler = createRedirectHandler(quickRouteMap, 8443, domains, caFile);
    const res = await withServer(handler, (port) => request(port, '/x', 'api.local'));
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://api.local:8443/x');
  });

  it('Pro mode (no CA): rejects an unknown host with 400 instead of reflecting it', async () => {
    const handler = createRedirectHandler(proRouteMap, 443, domains, null);
    const res = await withServer(handler, (port) => request(port, '/', 'evil.example.com'));
    expect(res.status).toBe(400);
  });

  it('Pro mode (no CA): still redirects a known host to HTTPS', async () => {
    const handler = createRedirectHandler(proRouteMap, 443, domains, null);
    const res = await withServer(handler, (port) => request(port, '/', 'api.myteam.dev'));
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://api.myteam.dev/');
  });
});

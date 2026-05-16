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
//   dynamoip serves on port 80 in Quick/Pro mode.

import { buildRouteMap, resolveTarget, buildCertPage } from '../../src/proxy.js';

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
  const domains = [{ name: 'api' }, { name: 'web' }];

  it('returns a valid HTML document', () => {
    const html = buildCertPage('/cert', domains, 443);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('includes links for every domain', () => {
    const html = buildCertPage('/cert', domains, 443);
    expect(html).toContain('api.local');
    expect(html).toContain('web.local');
  });

  it('omits port suffix for port 443', () => {
    const html = buildCertPage('/cert', domains, 443);
    expect(html).not.toContain(':443');
  });

  it('includes port suffix for non-standard port', () => {
    const html = buildCertPage('/cert', domains, 8443);
    expect(html).toContain(':8443');
  });

  it('includes a CA certificate download link', () => {
    const html = buildCertPage('/cert', domains, 443);
    expect(html).toContain('dynamoip-ca.crt');
  });
});

// cloudflare.js — Cloudflare API client helpers
//
// getApexDomain: uses the Public Suffix List (via tldts) to extract the registrable
//   domain from any baseDomain string. This is needed because Cloudflare zones are
//   keyed on the apex (e.g. "myteam.co.uk"), not on subdomains like "local.myteam.co.uk".
//   Throws if the input has no recognisable TLD.
//
// Other exports (cfFetch, getZoneId, upsertARecords, etc.) make live HTTP calls to
//   the Cloudflare API and are not unit-tested here.

import { getApexDomain, planDnsRecords } from '../../src/cloudflare.js';

describe('getApexDomain', () => {
  it('returns the apex for a plain domain', () => {
    expect(getApexDomain('example.com')).toBe('example.com');
  });

  it('strips a single subdomain', () => {
    expect(getApexDomain('api.example.com')).toBe('example.com');
  });

  it('strips multiple subdomains', () => {
    expect(getApexDomain('local.myteam.dev')).toBe('myteam.dev');
    expect(getApexDomain('a.b.c.example.com')).toBe('example.com');
  });

  it('handles multi-label TLDs (co.uk) correctly', () => {
    expect(getApexDomain('local.myteam.co.uk')).toBe('myteam.co.uk');
  });

  it('handles .dev TLD', () => {
    expect(getApexDomain('myteam.dev')).toBe('myteam.dev');
  });

  it('throws for a bare hostname with no recognisable TLD', () => {
    expect(() => getApexDomain('notadomain')).toThrow();
  });
});

// planDnsRecords decides which existing records to delete and whether one already
// matches the desired state. This is the reconcile logic behind upsertARecords /
// upsertCnameRecords — the fix for only ever inspecting result[0].
describe('planDnsRecords', () => {
  const A = (id, content, extra = {}) => ({ id, type: 'A', name: 'x', content, proxied: false, ...extra });
  const AAAA = (id, content) => ({ id, type: 'AAAA', name: 'x', content, proxied: false });
  const CNAME = (id, content, proxied = true) => ({ id, type: 'CNAME', name: 'x', content, proxied });

  it('creates when there are no existing records', () => {
    const plan = planDnsRecords([], { type: 'A', content: '192.168.1.42' });
    expect(plan).toEqual({ keepId: null, deleteIds: [] });
  });

  it('keeps a matching A record and deletes nothing', () => {
    const plan = planDnsRecords([A('r1', '192.168.1.42')], { type: 'A', content: '192.168.1.42' });
    expect(plan).toEqual({ keepId: 'r1', deleteIds: [] });
  });

  it('deletes a stale A record with a different IP (no keep)', () => {
    const plan = planDnsRecords([A('r1', '10.0.0.9')], { type: 'A', content: '192.168.1.42' });
    expect(plan).toEqual({ keepId: null, deleteIds: ['r1'] });
  });

  it('keeps the matching A but cleans up a co-existing AAAA (the result[0] bug)', () => {
    // Cloudflare returns records in arbitrary order — the stale AAAA might be first.
    const plan = planDnsRecords(
      [AAAA('r-aaaa', '::1'), A('r-a', '192.168.1.42')],
      { type: 'A', content: '192.168.1.42' },
    );
    expect(plan.keepId).toBe('r-a');
    expect(plan.deleteIds).toEqual(['r-aaaa']);
  });

  it('deletes duplicate matching A records, keeping only one', () => {
    const plan = planDnsRecords(
      [A('r1', '192.168.1.42'), A('r2', '192.168.1.42')],
      { type: 'A', content: '192.168.1.42' },
    );
    expect(plan.keepId).toBe('r1');
    expect(plan.deleteIds).toEqual(['r2']);
  });

  it('replaces a leftover CNAME when an A record is wanted', () => {
    const plan = planDnsRecords(
      [CNAME('r-cname', 'tid.cfargotunnel.com')],
      { type: 'A', content: '192.168.1.42' },
    );
    expect(plan).toEqual({ keepId: null, deleteIds: ['r-cname'] });
  });

  it('requires proxied to match for CNAME (Max mode)', () => {
    const target = 'tid.cfargotunnel.com';
    // Same content but not proxied → must be replaced.
    const unproxied = planDnsRecords([CNAME('r1', target, false)], { type: 'CNAME', content: target, proxied: true });
    expect(unproxied).toEqual({ keepId: null, deleteIds: ['r1'] });

    const proxied = planDnsRecords([CNAME('r2', target, true)], { type: 'CNAME', content: target, proxied: true });
    expect(proxied).toEqual({ keepId: 'r2', deleteIds: [] });
  });

  it('replaces a leftover A record when a CNAME is wanted (Pro → Max switch)', () => {
    const target = 'tid.cfargotunnel.com';
    const plan = planDnsRecords([A('r-a', '192.168.1.42')], { type: 'CNAME', content: target, proxied: true });
    expect(plan).toEqual({ keepId: null, deleteIds: ['r-a'] });
  });
});

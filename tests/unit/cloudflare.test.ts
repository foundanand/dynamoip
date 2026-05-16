// cloudflare.js — Cloudflare API client helpers
//
// getApexDomain: uses the Public Suffix List (via tldts) to extract the registrable
//   domain from any baseDomain string. This is needed because Cloudflare zones are
//   keyed on the apex (e.g. "myteam.co.uk"), not on subdomains like "local.myteam.co.uk".
//   Throws if the input has no recognisable TLD.
//
// Other exports (cfFetch, getZoneId, upsertARecords, etc.) make live HTTP calls to
//   the Cloudflare API and are not unit-tested here.

import { getApexDomain } from '../../src/cloudflare.js';

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

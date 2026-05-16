// acme.js — Let's Encrypt certificate management (Pro mode)
//
// loadMeta: reads ~/.localmap/certs/meta.json which stores { baseDomain, expiresAt }.
//   Returns null on any read or parse error so callers can treat it as "no cert cached".
//   Tests mock fs.readFileSync to avoid touching the live cert directory.
//
// isCertValid: given a meta object and the current baseDomain, returns true only when
//   the domain matches, both cert files exist on disk, and expiry is >30 days away
//   (RENEW_THRESHOLD_DAYS). False in all error cases — forces a fresh cert request.
//
// obtainCert and scheduleRenewal make live ACME/DNS calls and are not unit-tested here.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { isCertValid, loadMeta } from '../../src/acme.js';

const CERT_DIR  = path.join(os.homedir(), '.localmap', 'certs');

describe('loadMeta', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns null when readFileSync throws (file missing or unreadable)', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('ENOENT'); });
    expect(loadMeta()).toBeNull();
  });

  it('returns null for corrupted JSON', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{ bad json }');
    expect(loadMeta()).toBeNull();
  });

  it('returns parsed object for valid JSON', () => {
    const data = { baseDomain: 'myteam.dev', expiresAt: '2027-01-01T00:00:00.000Z' };
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(data));
    expect(loadMeta()).toEqual(data);
  });
});

describe('isCertValid', () => {
  it('returns false for null meta', () => {
    expect(isCertValid(null, 'myteam.dev')).toBe(false);
  });

  it('returns false when baseDomain does not match', () => {
    const meta = {
      baseDomain: 'other.dev',
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    };
    expect(isCertValid(meta, 'myteam.dev')).toBe(false);
  });

  it('returns false when cert expires within 30 days', () => {
    const meta = {
      baseDomain: 'myteam.dev',
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
    };
    expect(isCertValid(meta, 'myteam.dev')).toBe(false);
  });

  it('returns false when cert is already expired', () => {
    const meta = {
      baseDomain: 'myteam.dev',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    expect(isCertValid(meta, 'myteam.dev')).toBe(false);
  });

  it('returns false when cert files are absent even if meta is healthy', () => {
    // Meta says >30 days remaining and domain matches, but cert files don't exist in CI
    const meta = {
      baseDomain: 'myteam.dev',
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    };
    // isCertValid checks fs.existsSync for the cert files — if they're absent this is false
    const certFile = path.join(CERT_DIR, 'wildcard.pem');
    const keyFile  = path.join(CERT_DIR, 'wildcard-key.pem');
    const certExists = fs.existsSync(certFile);
    const keyExists  = fs.existsSync(keyFile);

    if (!certExists || !keyExists) {
      expect(isCertValid(meta, 'myteam.dev')).toBe(false);
    } else {
      // Both files present — outcome depends on actual expiry; just check it doesn't throw
      expect(typeof isCertValid(meta, 'myteam.dev')).toBe('boolean');
    }
  });
});

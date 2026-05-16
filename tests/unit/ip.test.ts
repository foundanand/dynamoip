// ip.js — LAN IP detection
//
// getLanIp: returns the machine's outward-facing IPv4 address by scanning
//   os.networkInterfaces() for the first non-internal IPv4 entry.
//   The LAN_IP env var overrides detection entirely — useful in Docker or
//   when the auto-detected address is wrong.
//
// The real-interface test will pass on any machine connected to a network.
// It will throw (and fail) if run with no network interfaces available.

import { getLanIp } from '../../src/ip.js';

describe('getLanIp', () => {
  let savedLanIp;

  beforeEach(() => { savedLanIp = process.env.LAN_IP; });
  afterEach(() => {
    if (savedLanIp === undefined) delete process.env.LAN_IP;
    else process.env.LAN_IP = savedLanIp;
  });

  it('returns the LAN_IP env var when set', () => {
    process.env.LAN_IP = '10.0.0.5';
    expect(getLanIp()).toBe('10.0.0.5');
  });

  it('returns a dotted IPv4 address from network interfaces', () => {
    delete process.env.LAN_IP;
    const ip = getLanIp();
    expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });
});

// ip.js — LAN IP detection
//
// getLanIp: returns the machine's outward-facing IPv4 address by scanning
//   os.networkInterfaces() for the first non-internal IPv4 entry.
//   The LAN_IP env var overrides detection entirely — useful in Docker or
//   when the auto-detected address is wrong.
//
// The real-interface test will pass on any machine connected to a network.
// It will throw (and fail) if run with no network interfaces available.

import os from 'os';
import { getLanIp } from '../../src/ip.js';

// Build a fake os.networkInterfaces() result.
const iface = (address, extra = {}) => ({
  address, family: 'IPv4', internal: false, netmask: '255.255.255.0',
  mac: '00:00:00:00:00:00', cidr: `${address}/24`, ...extra,
});

describe('getLanIp', () => {
  let savedLanIp;

  beforeEach(() => { savedLanIp = process.env.LAN_IP; });
  afterEach(() => {
    if (savedLanIp === undefined) delete process.env.LAN_IP;
    else process.env.LAN_IP = savedLanIp;
    vi.restoreAllMocks();
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

  it('prefers a 192.168.x LAN address over a Docker bridge (172.17.x)', () => {
    delete process.env.LAN_IP;
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      docker0: [iface('172.17.0.1')],
      en0: [iface('192.168.1.42')],
    });
    expect(getLanIp()).toBe('192.168.1.42');
  });

  it('prefers a real LAN address over a Tailscale CGNAT (100.x) address', () => {
    delete process.env.LAN_IP;
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      tailscale0: [iface('100.101.102.103')],
      en0: [iface('192.168.0.7')],
    });
    expect(getLanIp()).toBe('192.168.0.7');
  });

  it('de-prioritises virtual interfaces by name even in the same address range', () => {
    delete process.env.LAN_IP;
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      // both 172.16/12 range; the non-virtual one should win
      'br-abc123': [iface('172.20.0.1')],
      eth0: [iface('172.20.5.9')],
    });
    expect(getLanIp()).toBe('172.20.5.9');
  });

  it('skips internal (loopback) addresses', () => {
    delete process.env.LAN_IP;
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      lo0: [iface('127.0.0.1', { internal: true })],
      en0: [iface('192.168.1.50')],
    });
    expect(getLanIp()).toBe('192.168.1.50');
  });

  it('throws when there is no external IPv4 interface', () => {
    delete process.env.LAN_IP;
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      lo0: [iface('127.0.0.1', { internal: true })],
    });
    expect(() => getLanIp()).toThrow(/No external IPv4/);
  });
});

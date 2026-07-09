import os from 'os';

// Score a candidate interface so we prefer a real LAN address over a VPN,
// Docker bridge, or other virtual interface. os.networkInterfaces() iteration
// order is not guaranteed, so picking "the first" one is fragile.
function scoreCandidate(name: string, address: string): number {
  let score = 0;

  // Prefer RFC 1918 private LAN ranges (most likely the physical Wi-Fi/Ethernet).
  if (/^192\.168\./.test(address)) score += 100;
  else if (/^10\./.test(address)) score += 90;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 80;

  // De-prioritise CGNAT/VPN-ish ranges (100.64.0.0/10 — Tailscale, carrier NAT).
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) score -= 60;

  // De-prioritise known virtual interface name patterns.
  if (/^(utun|tun|tap|docker|br-|veth|vboxnet|vmnet|zt|wg|tailscale)/i.test(name)) score -= 200;

  return score;
}

export function getLanIp(): string {
  if (process.env.LAN_IP) return process.env.LAN_IP;

  const nets = os.networkInterfaces();
  const candidates: { name: string; address: string }[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push({ name, address: net.address });
    }
  }

  if (candidates.length === 0) {
    throw new Error('No external IPv4 interface found. Are you connected to a network?');
  }

  candidates.sort((a, b) => scoreCandidate(b.name, b.address) - scoreCandidate(a.name, a.address));
  return candidates[0].address;
}

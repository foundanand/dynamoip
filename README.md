# dynamoip

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/dynamoip)](https://www.npmjs.com/package/dynamoip)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14-brightgreen)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20(Docker)-lightgrey)](#requirements)
[![Visitors](https://visitor-badge.laobi.icu/badge?page_id=foundanand.dynamoip)](https://visitor-badge.laobi.icu)

**Give your local services real domain names and trusted HTTPS — reachable from your network or the entire internet.**

```
https://app.yourdomain.com      →  localhost:3000
https://api.yourdomain.com      →  localhost:4000
https://admin.yourdomain.com    →  localhost:5000
```

No "connection not secure" warnings. No cert installation on other devices. Works on every phone, tablet, and computer on your Wi-Fi — or anywhere on the internet with Max mode.

---

## Who is this for?

### Developers

You're building a web app and need to test on a real phone — camera APIs, push notifications, touch targets, PWA install. `localhost` doesn't reach your phone. ngrok works but resets your URL on every restart and throttles requests.

dynamoip gives your dev server a stable domain your phone can always reach, with a real trusted certificate — no browser warnings, no tunnels, no accounts.

```
https://myapp.yourdomain.com  →  your dev server (port 3000)
```

WebSocket upgrades work too, so Vite HMR and Next.js Fast Refresh keep working on your phone just like they do on your laptop.

### Small teams and startups

Your team works in the same office. You're building a product with a frontend, an API, and an admin panel — all running on your laptop. You want your designer to open the real app on their machine, your PM to test on their phone, and your backend engineer to call the API directly. Nobody wants to deal with IP addresses, port numbers, or expired ngrok URLs.

dynamoip gives every service a real domain with trusted HTTPS, reachable by the whole team on the same Wi-Fi — instantly, every time you start it.

```
https://app.yourdomain.com      →  React frontend    (port 3000)
https://api.yourdomain.com      →  Node API          (port 4000)
https://admin.yourdomain.com    →  Admin panel       (port 5000)
```

No IT setup. No VPN. No tunnels. Just Wi-Fi.

### Home automation and self-hosted services

You run Home Assistant, Grafana, Plex, or a custom dashboard on a Raspberry Pi or home server. Right now you access it by remembering `192.168.1.42:8123`. You want `https://home.yourdomain.com` — something you can bookmark, share with your family, and open from any device without a security warning.

dynamoip registers DNS in Cloudflare and issues a Let's Encrypt certificate automatically. Every device on your home network — phones, tablets, smart TVs — gets a real URL with full HTTPS, without installing anything on those devices.

```
https://home.yourdomain.com     →  Home Assistant    (port 8123)
https://media.yourdomain.com    →  Plex / Jellyfin   (port 8096)
https://stats.yourdomain.com    →  Grafana           (port 3000)
https://files.yourdomain.com    →  Nextcloud         (port 8080)
```

---

## Three modes

### Max mode — Cloudflare Tunnel (public internet access)

Your services become accessible from anywhere on the internet — not just your LAN. Uses a Cloudflare Tunnel to route all traffic (including LAN traffic) through Cloudflare's edge. No ACME cert needed; Cloudflare handles TLS. No sudo required.

**What you need:** a domain on Cloudflare, a Cloudflare API token with tunnel permissions, `cloudflared` installed.

### Pro mode — Cloudflare + Let's Encrypt (LAN, recommended for teams)

Uses a real domain you own. dynamoip sets DNS A records in Cloudflare and obtains a Let's Encrypt wildcard certificate automatically. Every device on the network trusts it out of the box — no setup on other devices at all.

**What you need:** a domain managed by Cloudflare (free tier works), a Cloudflare API token.

### Quick mode — mDNS `.local` (LAN, no domain required)

No domain needed. Uses mDNS to broadcast `.local` hostnames on the LAN. Other devices need to install a CA certificate once.

**What you need:** mkcert (`brew install mkcert`), sudo.

---

## Requirements

- **Node.js** >= 14
- **macOS** or **Linux** — native. **Windows** — supported via Docker (see [docs/docker.md](docs/docker.md))
- **sudo** — required for Pro/Quick mode to bind to ports 80 and 443. Use `--port 8443` to avoid this. **Max mode does not need sudo.**

**Max mode additionally:**
- A domain managed by Cloudflare (free tier works)
- Cloudflare API token with `Zone:DNS:Edit` + `Account:Cloudflare Tunnel:Edit` permissions
- `cloudflared` — installed automatically on first run (Homebrew on macOS, binary download on Linux)

**Pro mode additionally:**
- A domain managed by Cloudflare (free tier works)
- Cloudflare API token with `Zone:DNS:Edit` permission

**Quick mode additionally:**
- mkcert — `brew install mkcert` (macOS) or [download a binary](https://github.com/FiloSottile/mkcert/releases) (Linux)

---

## Installation

Install as a dev dependency in your project (recommended):

```bash
npm install --save-dev dynamoip   # npm
pnpm add -D dynamoip              # pnpm
yarn add -D dynamoip              # yarn
```

Or install globally:

```bash
npm install -g dynamoip
```

---

## Max mode setup

Max mode exposes your local services to the public internet using Cloudflare Tunnels. No sudo required — cloudflared makes an outbound connection, so no privileged ports are needed.

`cloudflared` is installed automatically on first run (via Homebrew on macOS, binary download on Linux). No manual install step needed.

**1. Create `dynamoip.config.json`:**

```json
{
  "baseDomain": "yourdomain.com",
  "domains": {
    "app": 3000,
    "api": 4000
  },
  "tunnel": true
}
```

**2. Create `.env`** — needs one extra token permission vs Pro mode:

```env
CF_API_TOKEN=your_cloudflare_api_token_here
```

The token needs both `Zone:DNS:Edit` and `Account:Cloudflare Tunnel:Edit` permissions. Create one at **https://dash.cloudflare.com/profile/api-tokens** — see [docs/tunnel.md](docs/tunnel.md) for the exact setup.

**3. Add a script to `package.json` and run:**

```json
"scripts": {
  "proxy:live": "dynamoip --config dynamoip.config.json"
}
```

```bash
npm run proxy:live    # no sudo needed
pnpm run proxy:live
yarn proxy:live
```

**What happens on first run:**
1. A named Cloudflare Tunnel is created and credentials are saved to `~/.localmap/tunnels/`
2. DNS CNAME records are set pointing each subdomain to the tunnel
3. The local proxy starts on `127.0.0.1:8080`
4. `cloudflared` connects to Cloudflare's edge

```
dynamoip starting...
LAN IP : 192.168.1.42
Mode   : Max — Cloudflare Tunnel (yourdomain.com)

Cloudflare Tunnel:
  Tunnel "dynamoip-yourdomain.com" created  (abc123...)

DNS records (CNAME -> tunnel):
  app.yourdomain.com -> abc123....cfargotunnel.com  (created)
  api.yourdomain.com -> abc123....cfargotunnel.com  (created)

Starting tunnel:
  cloudflared -> http://127.0.0.1:8080

Starting proxy:
  HTTP 127.0.0.1:8080  -> proxying by Host header

Ready:

  [PUBLIC]  https://app.yourdomain.com
  [PUBLIC]  https://api.yourdomain.com

  Live on the internet — accessible from anywhere.
  Anyone with the URL can reach these services.
```

On subsequent runs, the tunnel is reused and DNS records are left unchanged — startup is near-instant.

> **Security note:** Max mode makes your services publicly reachable. Add authentication to any service you expose, and stop dynamoip when not in use.

See [docs/tunnel.md](docs/tunnel.md) for the full guide, including token setup and troubleshooting.

---

## Pro mode setup

**1. Create `dynamoip.config.json`** in your project directory:

```json
{
  "baseDomain": "yourdomain.com",
  "domains": {
    "app": 3000,
    "api": 4000
  }
}
```

`baseDomain` can be your apex domain (`yourdomain.com`) or any subdomain (`dev.yourdomain.com`). dynamoip will create `app.yourdomain.com`, `api.yourdomain.com`, etc.

**2. Create `.env`** in the same directory (never commit this):

```env
CF_API_TOKEN=your_cloudflare_api_token_here
CF_EMAIL=you@example.com
```

Get a token at **https://dash.cloudflare.com/profile/api-tokens** → Create Token, using the **Edit zone DNS** template scoped to your domain.

**3. Add a script to `package.json`:**

```json
"scripts": {
  "dev:proxy": "dynamoip --config dynamoip.config.json"
}
```

**4. Run:**

```bash
sudo npm run dev:proxy    # npm
sudo pnpm run dev:proxy   # pnpm
sudo yarn dev:proxy       # yarn
```

> Always run via your package manager — not bare `sudo dynamoip`. Package managers add `node_modules/.bin` to PATH when running scripts; sudo's restricted PATH won't find the binary otherwise.

**What happens on first run** (~1 minute):
1. DNS A records are set in Cloudflare pointing to your LAN IP
2. A DNS-01 ACME challenge is issued — dynamoip sets a TXT record in Cloudflare and waits for propagation
3. Let's Encrypt validates the challenge and issues a wildcard certificate
4. The proxy starts and your domains are live

```
dynamoip starting...
LAN IP : 192.168.1.42
Mode   : Pro — Cloudflare + Let's Encrypt (yourdomain.com)

DNS records (Cloudflare):
  app.yourdomain.com -> 192.168.1.42  (created)
  api.yourdomain.com -> 192.168.1.42  (created)

Certificates (Let's Encrypt):
  Obtaining Let's Encrypt certificate via DNS-01...
  Setting DNS TXT record for ACME challenge...
  Waiting for DNS propagation...
  DNS propagation confirmed
  Certificate issued, valid until 2025-07-01

Starting proxy:
  HTTPS 0.0.0.0:443  -> proxying by Host header
  HTTP  :80          -> redirects to HTTPS

Ready:

  [LAN]   https://app.yourdomain.com
  [LAN]   https://api.yourdomain.com

  Accessible from devices on this network only.
```

After the first run, the certificate is cached in `~/.localmap/certs/` and startup is instant.

**5. Open on any device on the same Wi-Fi** — no prompts, no setup required.

---

## Quick mode setup

**1. Create `dynamoip.config.json`** — no `baseDomain` field:

```json
{
  "domains": {
    "app": 3000,
    "api": 4000
  }
}
```

**2. Add a script to `package.json`** and run:

```json
"scripts": {
  "dev:proxy": "dynamoip --config dynamoip.config.json"
}
```

```bash
sudo npm run dev:proxy    # npm
sudo pnpm run dev:proxy   # pnpm
sudo yarn dev:proxy       # yarn
```

mkcert installs a local CA on first run (may prompt for your password), then generates a certificate covering all configured `.local` domains.

**3. Access from this machine:**

```
https://app.local
https://api.local
```

**Trusting HTTPS on other devices** requires installing the CA certificate once per device. The startup output prints the CA cert path and per-platform instructions.

---

## Adding dynamoip to a project

See [docs/local-development.md](docs/local-development.md) for the full guide.

**1. Install:**

```bash
npm install --save-dev dynamoip   # npm
pnpm add -D dynamoip              # pnpm
yarn add -D dynamoip              # yarn
```

**2. Add `dynamoip.config.json`** to your project root (see [`dynamoip.config.example.json`](dynamoip.config.example.json) for the format).

**3. Add scripts to `package.json`:**

```json
"scripts": {
  "dev:proxy": "dynamoip --config dynamoip.config.json", // Dev enviroment
  "proxy": "dynamoip --config dynamoip.config.json"  // Prod environment (Local networks)
}
```

Use `dev:proxy` when running alongside your dev server. Use `proxy` as a standalone command for production-like or home server setups.

**4. Run:**

```bash
# Development — run alongside your app
sudo npm run dev:proxy    # npm
sudo pnpm run dev:proxy   # pnpm
sudo yarn dev:proxy       # yarn

# Standalone / production
sudo npm run proxy
sudo pnpm run proxy
sudo yarn proxy
```

> Always run via your package manager — not bare `sudo dynamoip`. Package managers add `node_modules/.bin` to PATH when running scripts; sudo's restricted PATH won't find the binary otherwise.

---

## Configuration reference

`dynamoip.config.json`:

| Field        | Type    | Required              | Description                                                     |
|--------------|---------|-----------------------|-----------------------------------------------------------------|
| `domains`    | object  | Yes                   | Map of name → local port. e.g. `{ "api": 4000 }`               |
| `baseDomain` | string  | Pro + Max mode        | Domain root for subdomains. e.g. `"yourdomain.com"`             |
| `tunnel`     | boolean | No (default: `false`) | Set `true` to enable Max mode (Cloudflare Tunnel)               |
| `port`       | number  | No (default: 443)     | Proxy listen port. Defaults to 8080 in Max mode, 443 in Pro/Quick, 80 in HTTP mode |

`.env`:

| Variable       | Required              | Description                                               |
|----------------|-----------------------|-----------------------------------------------------------|
| `CF_API_TOKEN` | Pro + Max mode        | Cloudflare API token (see mode-specific permission requirements above) |
| `CF_EMAIL`     | No                    | Email for Let's Encrypt expiry notifications (Pro mode)   |
| `LAN_IP`       | Docker on macOS/Win (Pro/Quick) | Override LAN IP auto-detection. Set to your machine's LAN IP (e.g. `192.168.1.42`). Not needed in Max mode or on Linux. |
| `TARGET_HOST`  | Docker on macOS/Win (Max mode)  | Host the proxy forwards requests to. Set to `host.docker.internal` so the container reaches services on the host machine. Defaults to `localhost`. |

**Domain name rules:** letters, numbers, and hyphens only. No dots. Normalized to lowercase.

---

## CLI options

```
Usage: dynamoip [options]

Options:
  --config <path>   Config file path (default: ./dynamoip.config.json)
  --port <n>        Override proxy port
  --no-ssl          Disable HTTPS, plain HTTP only
  --help            Show this help
```

---

## How it works

### Max mode

```
Any device (LAN or internet)
  Browser → https://app.yourdomain.com
      │
      │  DNS: CNAME → {tunnel-id}.cfargotunnel.com
      │
      ▼
Cloudflare edge  (handles TLS)
      │
      │  Encrypted tunnel (outbound from your machine)
      ▼
cloudflared daemon (on your machine)
      │
      │  http://127.0.0.1:8080
      ▼
dynamoip proxy (localhost only)
      │
      ├──  app.yourdomain.com  →  localhost:3000
      └──  api.yourdomain.com  →  localhost:4000
```

1. **Named Cloudflare Tunnel** — created via API on first run. Credentials stored in `~/.localmap/tunnels/`. Reused on every subsequent startup.
2. **CNAME DNS records** — each subdomain points to `{tunnel-id}.cfargotunnel.com`. Cloudflare routes incoming requests to the tunnel.
3. **cloudflared daemon** — makes an outbound connection to Cloudflare. No inbound ports needed. No firewall rules. No sudo.
4. **Local proxy on 127.0.0.1** — the proxy is not LAN-exposed; all external and LAN traffic goes through Cloudflare's edge.

### Pro mode

```
Other device
  Browser → https://app.yourdomain.com
      │
      │  Public DNS (Cloudflare)
      │  app.yourdomain.com → 192.168.x.x  (your LAN IP)
      │
      ▼
Your machine (192.168.x.x)
  ┌──────────────────────────────────────────────────────┐
  │  dynamoip Proxy — HTTPS :443                         │
  │  Let's Encrypt wildcard cert for *.yourdomain.com    │
  │                                                      │
  │  app.yourdomain.com  →  localhost:3000               │
  │  api.yourdomain.com  →  localhost:4000               │
  └──────────────────────────────────────────────────────┘
```

1. **Cloudflare DNS** — dynamoip upserts A records pointing each subdomain to your current LAN IP.
2. **Let's Encrypt cert** — obtained via DNS-01 challenge. Cloudflare sets the required TXT records via API. No public port exposure needed.
3. **Cert cache** — stored in `~/.localmap/certs/`. Reused until 30 days before expiry, then auto-renewed in the background.
4. **Hot reload** — renewed certificates are applied with `server.setSecureContext()` — no restart needed.

### Quick mode

```
Other device
  Browser → https://app.local
      │
      │  mDNS (link-local, same Wi-Fi only)
      │  app.local → 192.168.x.x
      │
      ▼
Your machine (192.168.x.x)
  ┌──────────────────────────────────────────────────────┐
  │  dynamoip Proxy — HTTPS :443                         │
  │  mkcert cert for *.local                             │
  │                                                      │
  │  app.local  →  localhost:3000                        │
  │  api.local  →  localhost:4000                        │
  └──────────────────────────────────────────────────────┘
```

1. **mDNS** — `dns-sd` (macOS) or `avahi` (Linux) broadcasts each `.local` hostname on the LAN.
2. **mkcert** — generates a cert trusted by this machine's keychain. Other devices need the CA cert installed once.

### Both modes

- Reverse proxy routes by `Host` header to the correct local port
- WebSocket upgrades forwarded transparently (Vite HMR, Next.js Fast Refresh, etc.)
- HTTP on port 80 redirects to HTTPS on port 443
- Ctrl+C cleans up all mDNS registrations before exiting

---

## Certificate lifecycle (Pro mode)

| Event | What happens |
|---|---|
| First run | DNS A records set, ACME challenge issued, cert obtained (~1 min) |
| Subsequent runs | Cert loaded from `~/.localmap/certs/` — instant startup |
| < 30 days to expiry | Background renewal triggered automatically |
| Renewal success | New cert hot-reloaded, no restart needed |
| Renewal failure | Exponential backoff: 6h → 12h → 24h → 48h (max 4 days) |
| Manual reset | Delete `~/.localmap/certs/` to force a fresh certificate |

---

## Running in Docker

Docker is supported on all platforms. On **Linux**, use `network_mode: host` and dynamoip auto-detects the LAN IP as normal. On **macOS and Windows**, set the `LAN_IP` environment variable to your machine's LAN IP before starting Docker — the container cannot see the host's real network interfaces.

```yaml
# docker-compose.yml
services:
  dynamoip:
    image: your-dynamoip-image
    environment:
      LAN_IP: ${LAN_IP:-}        # set on host before running docker compose
      CF_API_TOKEN: ${CF_API_TOKEN}
```

```bash
# macOS — detect and export before starting
export LAN_IP=$(route -n get default | awk '/interface:/{print $2}' | xargs ipconfig getifaddr)
docker compose up
```

See [docs/docker.md](docs/docker.md) for the full guide, including Windows instructions and a startup script that auto-detects `LAN_IP` on every run.

---

## Running the examples

```bash
# Terminal 1
node examples/inventory/server.js    # port 3000

# Terminal 2
node examples/dashboard/server.js    # port 6000

# Terminal 3 — from the dynamoip repo root
npm start   # Max mode — no sudo needed
# sudo npm start  # Pro/Quick mode
```

---

## Project structure

```
dynamoip/
├── bin/
│   └── dynamoip.js        Entry point — argument parsing, startup orchestration
├── src/
│   ├── config.js          Config loading, validation, .env parsing
│   ├── cloudflare.js      Cloudflare API — zone lookup, A/CNAME records, ACME TXT records
│   ├── tunnel.js          Cloudflare Tunnel lifecycle — create, credential storage, cloudflared
│   ├── acme.js            Let's Encrypt DNS-01 flow, cert cache, renewal scheduler
│   ├── certs.js           mkcert integration (quick mode)
│   ├── proxy.js           HTTP/HTTPS reverse proxy, WebSocket support
│   ├── mdns.js            mDNS registration — dns-sd (macOS), avahi (Linux)
│   ├── ip.js              LAN IP detection
│   └── cleanup.js         Signal handling, child process cleanup
├── docs/
│   ├── local-development.md   Using dynamoip in your own projects
│   ├── docker.md              Running dynamoip in Docker
│   └── tunnel.md              Max mode — Cloudflare Tunnel setup guide
├── examples/
│   ├── inventory/         Example inventory app (port 3000)
│   └── dashboard/         Example dashboard app (port 6000)
├── dynamoip.config.example.json   Config template
└── .env.example                   Environment variable template
```

---

## Troubleshooting

**`CF_API_TOKEN` not found**
Add it to a `.env` file next to your config. See `.env.example` for the format.

**Cloudflare zone not found**
Verify the token has `Zone:DNS:Edit` permission and is scoped to the correct domain. You can test the token at Cloudflare Dashboard → My Profile → API Tokens → the token's row → Test.

**First run shows "TXT record not confirmed in public DNS — proceeding anyway"**
This warning is harmless. It means the DNS propagation polling timed out but Let's Encrypt validated successfully anyway. If the certificate was issued, you can ignore it.

**Certificate error on first run**
Delete `~/.localmap/certs/` and retry. Verify `CF_API_TOKEN` has the correct permissions.

**Domains not resolving on other devices**
After a new A record, DNS can take up to 60 seconds to propagate. TTL is set to 60s so stale LAN IP records clear quickly.

**`sudo: dynamoip: command not found`**
Do not run `sudo dynamoip` directly — sudo uses a restricted PATH that doesn't include `node_modules/.bin`. Always run via your package manager: `sudo npm run dev:proxy`, `sudo pnpm run dev:proxy`, or `sudo yarn dev:proxy`.

**`EACCES` on port 443 or 80**
Run with `sudo`. This is required to bind to privileged ports (< 1024). Use `--port 8443` to avoid sudo — your URLs will include the port number. Max mode does not require sudo.

**Max mode: `cloudflared is required for Max mode`**
Install cloudflared: `brew install cloudflared` (macOS) or see [Cloudflare's install docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

**Max mode: `Cloudflare API error` on tunnel creation**
Your token likely lacks `Account:Cloudflare Tunnel:Edit` permission. See [docs/tunnel.md](docs/tunnel.md) for exact token setup.

**Max mode: `tunnel: true` but no `baseDomain`**
Max mode requires a `baseDomain`. Add `"baseDomain": "yourdomain.com"` to your config.

**Max mode: domains accessible on LAN but not externally**
DNS CNAME records may not have propagated yet. Wait up to 60 seconds after the first run. You can verify with `dig app.yourdomain.com` — should return `CNAME → {tunnel-id}.cfargotunnel.com`.

**Quick mode: `.local` not resolving on another device**
Both devices must be on the same Wi-Fi (not one on Ethernet). Check your firewall allows UDP 5353. Verify on macOS with `dns-sd -G v4 app.local`.

**Linux: mDNS registration fails**
`sudo apt install avahi-daemon avahi-utils && sudo systemctl start avahi-daemon`

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Found a bug? [Open an issue](https://github.com/foundanand/dynamoip/issues).
Have a question? [Start a discussion](https://github.com/foundanand/dynamoip/discussions).

---

## License

MIT — see [LICENSE](LICENSE).

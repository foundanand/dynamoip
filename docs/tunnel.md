# Max mode — Cloudflare Tunnel

Max mode exposes your local dev servers to the **public internet** using Cloudflare Tunnels. The same URL works from your local network, a coffee shop, a phone on cellular, or anywhere in the world.

No sudo required. No firewall rules. No open inbound ports.

---

## How it works

```
Any device (LAN or internet)
  Browser → https://app.yourdomain.com
      │
      │  DNS: CNAME → {tunnel-id}.cfargotunnel.com
      ▼
Cloudflare edge  (terminates TLS, trusted cert)
      │
      │  Encrypted outbound tunnel
      ▼
cloudflared daemon  (running on your machine)
      │
      │  http://127.0.0.1:8080
      ▼
dynamoip proxy  (localhost only)
      │
      ├──  app.yourdomain.com  →  localhost:3000
      └──  api.yourdomain.com  →  localhost:4000
```

- cloudflared makes an **outbound** connection to Cloudflare — no inbound ports needed
- Cloudflare handles TLS — no ACME / Let's Encrypt cert needed
- The local proxy runs on `127.0.0.1` (not exposed on your LAN directly)
- All traffic — whether from your LAN or the internet — goes through Cloudflare's edge

---

## Prerequisites

1. **A domain managed by Cloudflare** — free Cloudflare account + any domain (even a cheap one)
2. **Cloudflare API token** — with two permissions (details below)

`cloudflared` is installed automatically on first run — no manual step needed.
- macOS: installed via Homebrew (`brew install cloudflared`)
- Linux: downloaded with `sudo curl` to `/usr/local/bin/cloudflared` (will prompt for your password once)

If you already have `cloudflared` in your PATH, that version is used as-is.

---

## Step 1 — Create a Cloudflare API token

Go directly to: **https://dash.cloudflare.com/profile/api-tokens**

1. Click **Create Token**
2. Scroll to the bottom and click **Create Custom Token → Get started**
3. Give it a name, e.g. `dynamoip`
4. Under **Permissions**, add two rows:
   - Row 1: `Zone` / `DNS` / `Edit`
   - Row 2: `Account` / `Cloudflare Tunnel` / `Edit`
   
   Use the **+ Add more** link between rows to add the second permission.
5. Under **Zone Resources** (appears after adding the Zone permission): set it to `Include → Specific zone → your domain`
6. Click **Continue to summary → Create Token**
7. Copy the token — it's only shown once

Paste it into your `.env`:
```env
CF_API_TOKEN=your_token_here
```

---

## Step 2 — Configure dynamoip

`dynamoip.config.json`:

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

`.env` (same directory as config, never commit):

```env
CF_API_TOKEN=your_token_here
```

---

## Step 3 — Run

Max mode does **not** require sudo:

```bash
npm run proxy:live     # or whatever script name you chose
pnpm run proxy:live
yarn proxy:live
```

Or directly:

```bash
npx dynamoip --config dynamoip.config.json
```

**First run output** (roughly):

```
dynamoip starting...
LAN IP : 192.168.1.42
Mode   : Max — Cloudflare Tunnel (yourdomain.com)

Cloudflare Tunnel:
  Tunnel "dynamoip-yourdomain.com" created  (a1b2c3d4-...)

DNS records (CNAME -> tunnel):
  app.yourdomain.com -> a1b2c3d4-....cfargotunnel.com  (created)
  api.yourdomain.com -> a1b2c3d4-....cfargotunnel.com  (created)

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

**Subsequent runs** — tunnel is reused, DNS is unchanged, startup is near-instant.

---

## Credential storage

On first run, dynamoip saves tunnel credentials to:

```
~/.localmap/tunnels/
├── {tunnel-id}.json          tunnel credentials  (mode 0600 — contains secret)
└── config-{tunnel-id}.yml    cloudflared ingress config  (rewritten each run)
```

The credentials file contains the tunnel secret and is only created once. If you delete it, dynamoip will recreate the tunnel on the next run (and update DNS accordingly).

---

## Stopping and restarting

Press **Ctrl+C** — dynamoip stops the cloudflared daemon cleanly. Your DNS CNAME records remain in Cloudflare; the tunnel will be unreachable until you restart dynamoip.

The tunnel credentials and Cloudflare Tunnel object persist across restarts. Next startup reuses them.

---

## Security considerations

Max mode makes your services **publicly reachable**. Keep these in mind:

- Add authentication to any service you expose (login screen, API key, etc.)
- Stop dynamoip when you're not actively using it — the tunnel goes down with the process
- DNS CNAME records stay in Cloudflare when stopped; they only resolve when cloudflared is running
- The tunnel credentials file (`~/.localmap/tunnels/*.json`) contains a secret — do not share or commit it
- Consider enabling Cloudflare Access on your domain (Zero Trust) for an extra auth layer

---

## Troubleshooting

**`cloudflared is required for Max mode`**
Install cloudflared (Step 1 above).

**`Cloudflare API error` when creating tunnel**
Your token is likely missing `Account:Cloudflare Tunnel:Edit`. Create a new token with both permissions (Step 2 above).

**`tunnel: true` requires `baseDomain`**
Add `"baseDomain": "yourdomain.com"` to your config. Max mode needs a real domain for DNS and routing.

**Services not accessible externally after first run**
CNAME records can take up to 60 seconds to propagate. Verify with:
```bash
dig app.yourdomain.com
# Should return a CNAME pointing to {tunnel-id}.cfargotunnel.com
```

**`[cloudflared] failed to connect`**
Check your internet connection. cloudflared needs to reach Cloudflare's edge servers. Also verify the credentials file at `~/.localmap/tunnels/{tunnel-id}.json` exists and is not corrupted (delete it to force recreation).

**Recreating a broken tunnel**
Delete the credentials file and restart:
```bash
rm ~/.localmap/tunnels/*.json
dynamoip --config dynamoip.config.json
```
This creates a fresh tunnel and updates DNS.

---

## Switching between Max and Pro mode

Max and Pro mode share the same `baseDomain` and `CF_API_TOKEN`. To switch:

- **Pro → Max**: Add `"tunnel": true` to config. DNS records will change from A records to CNAME on next run.
- **Max → Pro**: Remove `"tunnel": true` from config. DNS records will change back to A records on next run.

The switch happens automatically on the next startup.

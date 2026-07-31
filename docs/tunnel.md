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

The credentials file contains the tunnel secret. If you delete it — or run dynamoip on a
second machine — the next startup fetches the secret back from Cloudflare and rewrites the
file. The tunnel itself is never deleted, so a tunnel that is still serving traffic is left
alone.

Tunnels are named `dynamoip-{baseDomain}-{hostname}`, so each machine gets its own. Two
machines sharing a `baseDomain` must not share a tunnel: Cloudflare would treat them as
replicas and load-balance one machine's hostnames onto the other, which has no ingress rule
for them and answers with the catch-all 404.

---

## Stopping and restarting

Press **Ctrl+C** — dynamoip stops accepting new requests, lets in-flight ones finish, waits
for cloudflared to drain its connections at Cloudflare's edge, then exits. Press Ctrl+C a
second time to skip the wait and kill everything immediately.

The same sequence runs on `SIGTERM` and `SIGHUP`, so `kill` and container stops shut down
cleanly too. This matters: a cloudflared left running after dynamoip exits keeps the
tunnel's connections open, and Cloudflare then refuses to delete that tunnel.

Your DNS CNAME records remain in Cloudflare; the tunnel is unreachable until you restart
dynamoip. The tunnel credentials and Cloudflare Tunnel object persist across restarts.

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
Check your internet connection. cloudflared needs to reach Cloudflare's edge servers. Also
verify the credentials file at `~/.localmap/tunnels/{tunnel-id}.json` is readable — an old
`sudo dynamoip` run can leave a root-owned copy that cloudflared cannot read.

**Recreating a broken tunnel**
Deleting the credentials file no longer forces recreation — dynamoip restores it from
Cloudflare. To get a genuinely fresh tunnel, delete the tunnel itself:
```bash
cloudflared tunnel delete dynamoip-{baseDomain}-{hostname}
dynamoip --config dynamoip.config.json
```
This creates a fresh tunnel and updates DNS.

**`This tunnel has active connections`**
Something is still serving the tunnel — usually a cloudflared left running by an earlier
dynamoip that was killed abruptly, or dynamoip running on another machine. Find it with
`pgrep -fl cloudflared`; if it is not on this machine, check the connection's `origin_ip`
in the Cloudflare Zero Trust dashboard.

---

## Switching between Max and Pro mode

Max and Pro mode share the same `baseDomain` and `CF_API_TOKEN`. To switch:

- **Pro → Max**: Add `"tunnel": true` to config. DNS records will change from A records to CNAME on next run.
- **Max → Pro**: Remove `"tunnel": true` from config. DNS records will change back to A records on next run.

The switch happens automatically on the next startup.

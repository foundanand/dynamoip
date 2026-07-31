# Changelog

All notable changes to dynamoip are documented here.
Detailed per-feature changelogs live in [`changelog/`](changelog/).

dynamoip uses [semantic versioning](https://semver.org/).

---

## [1.0.8] — 2026-07-31

### Fixed
- **`This tunnel has active connections` on startup (Max mode)**: tunnels were named `dynamoip-{baseDomain}`, so every machine sharing a `baseDomain` competed for one tunnel. A machine without the credentials file — which is every machine but the one that created it — treated the tunnel as unrecoverable and tried to `DELETE` it. Cloudflare refuses to delete a tunnel with live connections, so startup failed outright. Tunnels are now named `dynamoip-{baseDomain}-{hostname}`, one per machine.
- **Lost tunnel credentials no longer destroy the tunnel**: a missing credentials file now triggers a fetch from Cloudflare's tunnel token endpoint, which returns the account tag, tunnel ID, and secret. The credentials file is rebuilt from that. The tunnel is never deleted, so one still serving traffic from another machine is left alone.
- **Root-owned credentials files are detected**: an earlier `sudo dynamoip` run could leave a root-owned `0600` credentials file. `existsSync` accepted it, then `cloudflared` failed to read it with an unrelated-looking error. The check is now a readability test, and an unreadable file is restored like a missing one.
- **Orphaned `cloudflared` after an abrupt exit**: shutdown sent `SIGTERM` to children and called `process.exit(0)` immediately, without waiting. A surviving `cloudflared` keeps the tunnel's connections open at Cloudflare's edge, which is what blocked the next startup. Children are now awaited before exit.
- **Child-process respawn race during shutdown**: the `cloudflared` and `dns-sd` auto-restart handlers only skipped respawning when the exit signal was `SIGTERM`. On Ctrl+C the child receives `SIGINT`, so a restart was scheduled mid-shutdown and could resurrect a process that then outlived dynamoip. Both handlers now check a shutdown flag, and their retry timers are `unref`'d.
- **HTTP servers were never closed on exit**: in-flight requests were cut off mid-response on Ctrl+C. Listeners now close and requests drain first.

### Changed
- **Graceful shutdown on `SIGINT`, `SIGTERM`, and `SIGHUP`**: stop accepting new connections, drain in-flight requests (3s cap, so a keep-alive or WebSocket connection cannot stall the exit), then wait up to 8s for child processes before `SIGKILL`. A second signal skips the wait and exits immediately.
- **Docker: pin `hostname:` in bridge networking** — tunnel names now depend on the hostname, and a container's default hostname is its ID, so recreating a container without a fixed `hostname:` orphans the old tunnel. Not applicable under `network_mode: host`, which supplies the host's hostname. See [docs/docker.md](docs/docker.md).

### Upgrade note
On first run after upgrading, each machine creates its own tunnel and repoints its DNS CNAME records to it. The old shared `dynamoip-{baseDomain}` tunnel is left in place and can be deleted once every machine has been upgraded:
```bash
cloudflared tunnel delete dynamoip-{baseDomain}
```

---

## [1.0.7] — 2026-05-19

### Changed
- **Full TypeScript migration**: all source files (`src/`, `bin/`) rewritten to TypeScript — no behavioural changes, pure type-safety upgrade for contributors
- **Build toolchain**: direct Node.js execution replaced by [tsdown](https://tsdown.dev) (Rolldown-backed successor to tsup); published output is `dist/dynamoip.cjs` with a sourcemap
- **Minimum Node.js version bumped to `>=18`**: Node 14 and 16 are EOL; required by `@types/node@^18` and `target: node18` in the build config
- **Async DNS in ACME module**: `dns.Resolver` replaced with `dns.promises.Resolver` — async DNS polling is now explicitly Promise-based rather than callback-wrapped
- **`getAccountId` moved to `cloudflare.ts`**: was previously in `tunnel.ts`; lives alongside the other Cloudflare API helpers

### Added
- **73-test vitest suite** covering all modules: config parsing, proxy routing, Cloudflare API helpers, ACME cert logic, tunnel config generation, mDNS cleanup, and LAN IP detection
- **`npm run typecheck`**: runs `tsc --noEmit` for type-only validation without triggering a build
- **`src/types.ts`**: shared interfaces (`DomainEntry`, `Config`, `CloudflareConfig`, `SslOptions`) used across all modules
- **`fatal(): never` helper in `config.ts`**: TypeScript-aware validation helper that enables correct flow-narrowing after each config check without casts
- **Smaller npm package**: `.npmignore` now excludes `src/`, `bin/`, `tests/`, and build config files — only `dist/` is shipped to npm

### Fixed
- **Start script used wrong file extension**: `package.json` `bin` entry pointed at `dynamoip.js`; corrected to `dist/dynamoip.cjs` after the tsdown build

---

## [1.0.6] — 2026-04-04

### Fixed
- **Proxy crash on WebSocket errors**: `http-proxy` passes a raw `net.Socket` (not `http.ServerResponse`) as the third argument when a WebSocket proxy error occurs. The error handler was calling `res.writeHead()` on the socket, which crashed the entire process. The handler now detects this case and calls `socket.destroy()` instead.
- **WebSocket HMR not working through proxy**: `http-proxy` 1.18.1 has a race condition with fast upstream servers (e.g. Next.js Turbopack) that send WebSocket frames in the same TCP packet as the 101 response — the HTTP parser sees binary frame bytes before the `upgrade` event fires. Replaced `proxy.ws()` with raw TCP piping via `net.connect()`, bypassing the HTTP parser entirely.
- **Next.js HMR unauthorized rejection**: Next.js 15+ validates the `Origin` header on HMR WebSocket connections as a CSRF guard. The proxy was forwarding the browser's `Origin: https://your-domain.com` to the upstream, which Next.js rejected. Both `Host` and `Origin` are now rewritten to the upstream address (`http://localhost:<port>`) before forwarding.
- **Repeated WebSocket error spam**: The same proxy error from the same host was logged on every retry. Rate-limited to once per 5 seconds per host+message combination.
- **Cloudflare DNS error when switching from Max to Pro mode**: `upsertARecords` only queried for existing `A` records (`?type=A`). If a `CNAME` record was left over from a previous Max mode run, Cloudflare rejected the new `A` record creation. Now queries all record types for the hostname and deletes any existing record before creating the `A` record.

### Added
- **Graceful restart**: Unhandled exceptions and rejected promises no longer kill the process permanently. dynamoip closes open servers and restarts `main()` with exponential backoff (2s → 4s → 8s → 16s → 30s, capped at 5 consecutive restarts). The counter resets after 5 minutes of stable operation. Startup errors (EACCES, EADDRINUSE, bad config) still exit immediately since they require user action.

---

## [1.0.5] — 2026-04-03

### Added
- **Max mode**: Cloudflare Tunnel support for public internet access — add `"tunnel": true` to config alongside `baseDomain`
- `src/tunnel.js` — tunnel lifecycle: create/reuse named tunnel, write credentials + ingress config, spawn `cloudflared` with auto-restart
- `docs/tunnel.md` — full Max mode setup guide including token creation walkthrough
- `cloudflared` auto-installed on first run: Homebrew on macOS, `sudo curl` to `/usr/local/bin` on Linux
- `TARGET_HOST` env var for Docker: controls which host the proxy forwards to (set to `host.docker.internal` on macOS/Windows)
- Docker + Max mode docs and compose examples added to `docs/docker.md`

### Changed
- "Ready:" output now labels every URL as `[PUBLIC]` (Max mode) or `[LAN]` (Pro/Quick) so exposure level is immediately visible
- Mode label in startup output now reads: `Max — Cloudflare Tunnel`, `Pro — Cloudflare + Let's Encrypt`, `Quick — mkcert`, or `HTTP`
- `startProxy` accepts `bindHost` (`127.0.0.1` in Max mode, `0.0.0.0` otherwise) and `baseDomain` as explicit params
- `src/cloudflare.js` exports `cfFetch` for reuse; adds `upsertCnameRecords` (sets `proxied: true` CNAME records for tunnel routing)
- README updated: three modes documented, Max mode setup section, architecture diagram, config reference expanded

---

## [1.0.4] — 2026-04-02

### Added
- Docker support: `LAN_IP` environment variable override allows running inside containers where auto-detected IPs are incorrect
- `docs/docker.md` with full Docker and Docker Compose setup guide
- `llms.txt` for LLM-readable project documentation
- `.env.example` with documented environment variables

---

## [1.0.3] — 2026-04-01

### Changed
- README: replaced bare `sudo dynamoip` invocations with package manager equivalents (`sudo npm exec`, `sudo npx`, `sudo pnpm exec`, `sudo yarn`) since `node_modules/.bin` is not in sudo's restricted `PATH`
- Added production setup section to README

---

## [1.0.2] — 2026-04-01

### Changed
- README: added pnpm and yarn install/run instructions alongside npm
- Local dev docs updated with pnpm and yarn equivalents

---

## [1.0.1] — 2026-04-01

### Changed
- Renamed all internal references from `localDNS`/`localdns` to `dynamoip`
- Rewrote README with clearer use-case framing

---

## [1.0.0] — 2026-04-01

### Added
- Pro mode: Cloudflare DNS + Let's Encrypt wildcard certificate via DNS-01 challenge
- Quick mode: mDNS `.local` hostnames via `dns-sd` (macOS) and `avahi` (Linux)
- HTTPS reverse proxy with Host-header routing and WebSocket support (Vite HMR, Next.js Fast Refresh)
- HTTP → HTTPS redirect on port 80
- Automatic certificate renewal with exponential backoff and hot-reload via `setSecureContext()`
- LAN IP auto-detection
- `--config`, `--port`, `--no-ssl`, `--help` CLI flags
- Concurrent ACME challenge support (handles both `*.domain` and `domain` SANs simultaneously)
- Cert cache in `~/.localmap/certs/` for instant subsequent startups
- Graceful shutdown with mDNS cleanup on Ctrl+C

### Security
- Shell commands use `spawnSync` with argument arrays — no string interpolation, no shell injection risk
- Private keys written with `0o600` permissions, cert directories with `0o700`
- Cloudflare API error responses truncated before logging to prevent credential leakage
- Cloudflare API requests have a 10-second timeout
- `.env` quote-stripping uses matched-pair logic to prevent silent token corruption

### Dependencies
- `acme-client` ^5.4.0 — ACME protocol client for Let's Encrypt
- `http-proxy` ^1.18.1 — reverse proxy with WebSocket support
- `tldts` ^7.0.27 — Public Suffix List parser for correct multi-label TLD handling

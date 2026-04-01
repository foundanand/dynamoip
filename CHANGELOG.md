# Changelog

All notable changes to dynamoip are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
dynamoip uses [semantic versioning](https://semver.org/).

---

## [Unreleased]

### Added
- Windows support for both Pro mode and Quick mode
- Quick mode on Windows uses `multicast-dns` (pure Node.js) — no external tools required
- Cross-platform `commandExists` helper in `src/utils.js` — uses `where` on Windows, `which` elsewhere
- `registerCallback` in `src/cleanup.js` for non-process teardown (used by Windows mDNS)
- Windows-aware EACCES error messages ("run as Administrator" instead of "run with sudo")
- mkcert install instructions for Windows (Chocolatey and Scoop)

---

## [1.0.0] — 2025-04-01

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

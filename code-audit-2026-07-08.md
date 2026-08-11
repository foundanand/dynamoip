# Code Audit — dynamoip — 2026-07-08

## Executive summary

dynamoip is a small, well-structured TypeScript CLI (11 source files, ~1,000 LOC) with a clear
mode-based architecture and genuinely good unit-test coverage of its pure logic (config parsing,
route mapping). No critical security holes or data-loss bugs were found — the proxy is not an open
relay (unknown hosts 404), secrets are written with `0o600`, and Cloudflare/ACME flows are sensibly
guarded. The two things that matter most: **(1) the Quick-mode CA-certificate trust page is fully
built, exported, and unit-tested but never actually served** — the HTTP server unconditionally
301-redirects, so the documented "download the CA cert on your other device" onboarding flow is
broken; and **(2) the auto-restart path leaks child processes and timers** — every recovery from an
uncaught error spawns a fresh `cloudflared`/`dns-sd` and a new renewal interval without killing the
old ones. A handful of medium/low correctness-and-UX issues round it out (silently-ignored `port`
config field, naive LAN-IP selection, single-record DNS assumptions).

## Statistics

Files reviewed: 11/11 source + 7 test files + CI + config (all reviewed) · Critical: 0 · High: 1 · Medium: 4 · Low: 4

---

## High findings

### [HIGH] src/proxy.ts:171-176 — Quick-mode CA-cert trust page is never served; the documented other-device onboarding flow is broken

`buildCertPage()` (proxy.ts:11) and the `/dynamoip-ca.crt` download link are built, exported, and
unit-tested (proxy.test.ts:99-127, whose comment states the page "dynamoip serves on port 80 in
Quick/Pro mode"). But the HTTP `redirectServer` handler unconditionally issues a `301` for **every**
path:

```js
redirectServer = http.createServer((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const portSuffix = proxyPort === 443 ? '' : `:${proxyPort}`;
  res.writeHead(301, { Location: `https://${host}${portSuffix}${req.url}` });
  res.end();
});
```

Consequence: in Quick mode, a user opening `http://app.local` on their phone (the intended way to
fetch and install the CA cert) is redirected straight to `https://app.local`, which fails with the
exact untrusted-cert warning the page exists to prevent — a chicken-and-egg dead end. Worse,
`bin/dynamoip.ts:221-222` computes `caCertPath` and stuffs it into `sslOpts`, but `startProxy` never
reads `sslOpts.caCertPath` and `bin` never prints the path either, so there is **no** path — UI or
console — by which a user can obtain the CA cert for other devices. README:325 ("The startup output
prints the CA cert path and per-platform instructions") is inaccurate.

Fix: in the redirect server, serve the trust page and cert before redirecting, e.g.:
```js
if (req.url === '/dynamoip-ca.crt' && sslOpts?.caCertPath) {
  res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="dynamoip-ca.crt"' });
  fs.createReadStream(sslOpts.caCertPath).pipe(res); return;
}
if (req.url === '/' /* and Quick mode */) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(buildCertPage('/dynamoip-ca.crt', domains, proxyPort)); return;
}
// else 301 → https
```
This requires threading `sslOpts.caCertPath` through (it's already on the type) and passing `domains`
(already in scope). At minimum, if the page is deliberately dropped, print `caCertPath` to the console
in `bin` and delete the dead `buildCertPage`/`caCertPath`/tests.
Confidence: high

---

## Medium

### [MEDIUM] bin/dynamoip.ts:90-108 — Auto-restart leaks child processes and the renewal interval on every recovery
`restartAfterError` closes the HTTP/HTTPS servers (`closeActiveServers`) and calls `run()` → `main()`
again, but never kills the already-spawned `cloudflared` (tunnel.ts:134), `dns-sd`/`avahi` children
(mdns.ts), or clears the previous `scheduleRenewal` interval (acme.ts:146). Each restart (up to 5)
therefore stacks a second `cloudflared` fighting over the same tunnel, duplicate mDNS registrations,
and multiple daily renewal timers hitting Let's Encrypt. Fix: before restarting, call `cleanup()`
(cleanup.ts:10) to SIGTERM registered children, and store the renewal interval id so it can be
`clearInterval`'d (or guard `scheduleRenewal` to run once).
Confidence: high

### [MEDIUM] bin/dynamoip.ts:127 — `port` config field is silently ignored in Pro/Quick/Max modes
`const defaultPort = useTunnel ? 8080 : (useAcme || useMkcert) ? 443 : (config.port || 80);` — the
config file's `port` is only consulted in the final HTTP (`--no-ssl`) branch. A user who sets
`"port": 8443` in `dynamoip.config.json` to avoid `sudo` in Pro mode is silently overridden to 443
and hits `EACCES`. The README config table (README:381) lists `port` as a general field, so this
violates documented behavior. Fix: use `config.port` as the fallback in the ACME/mkcert branches too,
or explicitly document that only `--port` overrides the port in TLS modes and reject `port` in config
for those modes.
Confidence: high

### [MEDIUM] src/ip.ts:5-11 — LAN IP detection returns the first non-internal IPv4, which is often a VPN/Docker/bridge interface
`getLanIp` returns the first `IPv4 && !internal` address in arbitrary interface-iteration order. On a
machine with an active VPN (e.g. `10.x`/`100.64.x`) or Docker bridge (`172.17.x`), it can silently
publish an unreachable IP to Cloudflare A records (Pro mode) or mDNS (Quick mode), so domains resolve
but nothing connects — a confusing, hard-to-diagnose failure. Mitigated by the documented `LAN_IP`
override, but the default is fragile. Fix: prefer private LAN ranges (`192.168.*`, `10.*`, `172.16–31.*`)
while de-prioritizing known virtual interface name patterns (`utun`, `docker`, `br-`, `tun`, `tap`),
or at least log the chosen interface so the user can spot a wrong pick.
Confidence: medium

### [MEDIUM] src/cloudflare.ts:110-119, 181-190 — DNS upsert inspects only `result[0]`, mishandling multiple existing records
Both `upsertARecords` and `upsertCnameRecords` query `?name=${fqdn}` (no type filter — correct, to
catch cross-type leftovers) but then only examine/delete `result[0]`. If two records exist for the
name (e.g. a stale A plus an AAAA, or two A records from a prior partial run), only one is removed and
the subsequent `POST` can be rejected by Cloudflare as a conflict, or leaves a stale record that keeps
resolving to the wrong target. Fix: iterate all `existing.result` and delete every record that doesn't
match the desired final state before creating the new one.
Confidence: medium

---

## Low

- **[LOW] src/tunnel.ts:128 — Shared `config.yml` path.** All tunnels write to a single
  `~/.localmap/tunnels/config.yml`; running dynamoip for two different `baseDomain`s at once clobbers
  the first instance's ingress. Fix: name the file per-tunnel, e.g. `config-${tunnelId}.yml`.
- **[LOW] src/proxy.ts:11 — Dead `certUrl` parameter.** `buildCertPage(certUrl, ...)` never uses
  `certUrl` (the link is hardcoded to `/dynamoip-ca.crt`). Remove the param (ties into the High finding).
- **[LOW] src/proxy.ts:174 — Host header reflected into redirect `Location`.** `Location:
  https://${host}...` echoes the client-supplied `Host`. Not a classic open-redirect (a victim can't
  be made to send a chosen Host to your server and follow it), but worth pinning to a configured host
  for hygiene. Fix: validate `host` against the route map before redirecting; 400 otherwise.
- **[LOW] src/config.ts:72-74 — Duplicate-target-port rejection may surprise.** Two domains pointing at
  the same upstream port is a legitimate setup (two hostnames → one service) but is hard-rejected.
  Confirm this restriction is intended; if not, drop the `seenPorts` check.

---

## Systemic issues & themes

1. **Restart/replace paths don't reconcile side effects.** The same root cause underlies the
   process/timer leak (Medium #1): `main()` performs several idempotent-at-first-run side effects
   (spawn children, set intervals, register signal-scoped cleanup) but there is no teardown symmetric
   to `closeActiveServers()`. A single `teardown()` that runs `cleanup()` + `clearInterval` before any
   re-`run()` would fix it centrally.
2. **Build/test artifacts describe features the runtime doesn't deliver.** The CA-cert page is
   exported, documented, and tested but unwired (High). Tests and doc comments assert intended behavior
   that the wiring never realizes — the unit tests pass while the feature is dead, so coverage gives
   false confidence here. An integration test that boots the HTTP server and GETs `/dynamoip-ca.crt`
   would have caught it.
3. **Cloudflare DNS reconciliation assumes a single record per name** (Medium #4) — consistent across
   both A and CNAME upsert helpers; fix once, apply to both.

## What the codebase does well

- Clean mode separation (Max/Pro/Quick/HTTP) with a single, readable decision block in `bin`.
- Secrets and private keys written with correct restrictive modes (`0o600`); ACME account key and
  tunnel credentials handled carefully.
- Thoughtful edge handling elsewhere: querying DNS without a type filter to catch cross-mode leftovers,
  appending (not replacing) ACME TXT records for concurrent challenges, raw-TCP WebSocket piping to
  dodge the Turbopack 101-frame race, and per-key rate-limited proxy error logging.
- Genuinely good, well-commented unit tests for the pure logic (config validation matrix, route map,
  host resolution).
- Sensible resilience: exponential backoff on restarts and on cert-renewal failure, `.unref()` on the
  renewal interval, graceful child cleanup on SIGINT/SIGTERM.

## Prioritized remediation plan

1. **Quick wins (small diff, high value)**
   - Print `caCertPath` in `bin` startup output (one line) so Quick mode is usable *today*, even before
     re-wiring the page (High, partial).
   - Use `config.port` as the fallback in the TLS branches, or document + reject it (Medium #2).
   - Per-tunnel `config.yml` filename (Low).
2. **Must-fix (ordered)**
   - Wire the CA-cert trust page + `/dynamoip-ca.crt` download into the redirect server, threading
     `sslOpts.caCertPath` (High).
   - Add a `teardown()` (`cleanup()` + `clearInterval`) invoked before every restart (Medium #1).
   - Reconcile all matching DNS records, not just `result[0]` (Medium #4).
3. **Worth scheduling**
   - Smarter LAN-IP heuristic with interface logging (Medium #3).
   - Integration smoke test that boots each mode's servers and asserts the served routes (would have
     caught the High finding).
</content>
</invoke>

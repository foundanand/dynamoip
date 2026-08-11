# 02 — Tunnel (Max) mode hardcodes the local proxy port to 8080

## Summary

In **Max mode (Cloudflare Tunnel)**, dynamoip hardcodes its local reverse-proxy
listener to `127.0.0.1:8080`. The `port` field in `dynamoip.config.json` is
**silently ignored** whenever `tunnel: true`. The only way to change the port is
the undocumented-for-this-mode `--port <n>` CLI flag.

If port 8080 is already taken by another local process, dynamoip cannot bind and
dies with `EADDRINUSE` — even though the port is purely internal (only
`cloudflared` ever connects to it; the user never types it). The default value
8080 is arbitrary and collides with a very common dev-tool port.

Reported by: anand — had a separate "tool server" (`/tmp/gateway-bin`) holding
:8080, so the tunnel's internal proxy clashed with it. Nucleus / neuron project,
June 2026.

## Reproduce

`dynamoip.config.json`:

```json
{ "baseDomain": "nucleus.ae", "domains": { "dev": 3000 }, "tunnel": true }
```

1. Start anything else on :8080 (`python3 -m http.server 8080`, etc.).
2. Run `dynamoip --config dynamoip.config.json`.
3. The proxy tries to bind `127.0.0.1:8080`, hits `EADDRINUSE`, and exits.

Even without a collision, the behaviour is surprising: adding `"port": 9090` to
the config has **no effect** in tunnel mode — the proxy still listens on 8080.

## Root cause

`bin/dynamoip.ts:127`

```ts
const defaultPort = useTunnel ? 8080 : (useAcme || useMkcert) ? 443 : (config.port || 80);
const proxyPort   = portOverride ?? defaultPort;   // line 128
```

When `useTunnel` is true, `defaultPort` is the literal `8080` — `config.port`
(parsed and validated in `src/config.ts:49`) is never consulted. `proxyPort`
flows into both the cloudflared ingress config (`writeTunnelConfig`,
`bin/dynamoip.ts:181`) and the listener (`startProxy`, `bin/dynamoip.ts:239`),
so the whole tunnel path is pinned to 8080 unless `--port` is passed.

Failure mode on collision: `src/proxy.ts:227-232` prints
`Port 8080 is already in use.` and calls `process.exit(1)`.

Note: on macOS the collision is binding-dependent — a process on IPv6 `*:8080`
and dynamoip's IPv4 `127.0.0.1:8080` can coexist by luck, which makes this an
intermittent, confusing failure rather than a deterministic one.

## Expected

The internal tunnel port should either:

1. **Honor `config.port` in tunnel mode** (minimal fix), or
2. **Auto-select a free port** (better) — since the port is internal-only,
   dynamoip should probe for an open port instead of hardcoding 8080, making
   collisions impossible and requiring zero config.

## Workaround (today)

Pass a free port explicitly:

```bash
dynamoip --config dynamoip.config.json --port 8090
```

## Suggested fix

Option 1 — honor config (one line, `bin/dynamoip.ts:127`):

```ts
const defaultPort = useTunnel
  ? (config.port || 8080)
  : (useAcme || useMkcert) ? 443 : (config.port || 80);
```

Option 2 — auto-pick a free port in tunnel mode (preferred). Because the port is
only ever reached by the local `cloudflared` process, dynamoip can bind to an
ephemeral port (listen on `0`, read back `server.address().port`) and pass that
same value to `writeTunnelConfig`. No user-visible port, no collisions, no
config needed. Keep `--port` / `config.port` as an optional override for anyone
who wants a stable port.

Either way: stop silently ignoring `config.port` in tunnel mode, and document
the `--port` override for Max mode in `--help` (currently it only mentions
"default: 443 with SSL, 80 without", which is wrong for tunnel mode → 8080).

## Files

- `bin/dynamoip.ts:127-128` — hardcoded default + override resolution
- `bin/dynamoip.ts:181,185` — port passed to cloudflared ingress
- `bin/dynamoip.ts:239` — port passed to `startProxy`
- `src/config.ts:49-52` — `port` parsed/validated but unused in tunnel mode
- `src/proxy.ts:227-232` — `EADDRINUSE` handling

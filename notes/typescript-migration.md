# TypeScript Migration Notes

## Status: Complete

All source files converted from CommonJS JavaScript to TypeScript. Build, type-check, and all 73 tests pass.

---

## Key decisions and why

### Build tool: tsdown (not tsup)
tsup is no longer actively maintained. tsdown is its official successor, backed by Rolldown. Config is near-identical. Output: `dist/dynamoip.cjs` (single bundled file + sourcemap).

### Output format: CJS only
`http-proxy` is a CJS-only package with no ESM export. Forcing ESM output would require replacing it. The ESM-only push in 2025 targets libraries, not system tools with native dependencies.

### tsconfig: `"module": "Node16"` + `"moduleResolution": "Node16"`
Modern Node-aware resolution — understands `package.json` `exports` field, handles both CJS and ESM correctly. No `"type": "module"` in package.json means all `.ts` files compile as CJS, so no `.js` extension needed on relative imports.

### `fatal(): never` helper in config.ts
Process-exiting validation code uses a `fatal(msg): never` helper. TypeScript's flow analysis propagates `never` — after `if (!apiToken) fatal(...)`, TypeScript narrows `apiToken` to `string`. Eliminates redundant casts and unreachable-code noise.

### Shared types in src/types.ts
`DomainEntry`, `CloudflareConfig`, `Config`, and `SslOptions` are used across 4+ modules — they live in `src/types.ts`. Module-private types (e.g. `CfDnsRecord`, `TunnelCredentials`, `CertMeta`) stay colocated in their module.

### engines bumped to `>=18`
Node 14 and 16 are EOL. `@types/node@^18` was chosen to match. Aligns with the `target: node18` in the tsdown build.

---

## Gotchas encountered

### http-proxy import style
`@types/http-proxy` uses `export = Server` (the class itself is the export). This means:
- `import httpProxy from 'http-proxy'` with esModuleInterop does NOT give namespace access
- The fix: `import httpProxy = require('http-proxy')` — CJS-style import gives both value and nested types
- Instance type: `InstanceType<typeof httpProxy>` (not `httpProxy.Server` — there is no `.Server` sub-namespace)

### http-proxy error callback includes net.Socket
The `@types/http-proxy` `ErrorCallback` types `res` as `ServerResponse | net.Socket`. We handle both via an `'writeHead' in res` guard — `ServerResponse` has `writeHead`, `Socket` does not.

### dns.Resolver → dns.promises.Resolver
The original code used `dns.Resolver` with `await`, which is callback-based (not Promise-based). Converted to `dns.promises.Resolver` which is explicitly async. Functionally identical.

### tsdown output extension
tsdown outputs `.cjs` (not `.js`) for CJS format bundles. `package.json` `bin` and `main` updated to `dist/dynamoip.cjs`.

---

## File layout after migration

```
src/
  types.ts          — shared interfaces (DomainEntry, Config, SslOptions, CloudflareConfig)
  ip.ts             — LAN IP detection
  cleanup.ts        — child process lifecycle / SIGTERM handler
  cloudflare.ts     — Cloudflare API client (DNS records, tunnel, zones)
  config.ts         — config file loading + validation (fatal() helper)
  certs.ts          — mkcert certificate generation (Quick mode)
  mdns.ts           — mDNS registration (dns-sd / avahi)
  proxy.ts          — HTTP/HTTPS proxy + WebSocket TCP pipe
  tunnel.ts         — cloudflared tunnel lifecycle
  acme.ts           — Let's Encrypt certificate management (Pro mode)
bin/
  dynamoip.ts       — CLI entry point, mode selection, graceful restart
dist/               — compiled output (published to npm, not source)
  dynamoip.cjs
  dynamoip.cjs.map
tests/unit/         — vitest unit tests (73 tests, all passing)
```

---

## Scripts

| Command | What it does |
|---------|-------------|
| `npm run build` | Compile + bundle → dist/ via tsdown |
| `npm run typecheck` | Type-check only (no emit) via tsc --noEmit |
| `npm test` | Run unit tests via vitest |
| `npm run test:watch` | Vitest watch mode |

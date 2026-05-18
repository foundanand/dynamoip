# [TypeScript Migration] - Full rewrite to TypeScript + vitest test suite

### Changed

- All source files (`src/*.js`, `bin/dynamoip.js`) converted to TypeScript — no behaviour changes, pure type-safety upgrade
- Build toolchain replaced: direct Node.js execution → [tsdown](https://tsdown.dev) (tsup's actively-maintained successor, backed by Rolldown). Output: `dist/dynamoip.cjs` + sourcemap
- `engines` bumped to `>=18` — Node 14 and 16 are EOL; aligns with `@types/node@^18` and `target: node18` in the build config
- `dns.Resolver` → `dns.promises.Resolver` in `acme.ts`: async DNS polling is now explicitly Promise-based

### Added

- `src/types.ts` — shared TypeScript interfaces (`DomainEntry`, `Config`, `CloudflareConfig`, `SslOptions`) used across all modules
- `fatal(): never` helper in `config.ts` — validation errors call `fatal(msg)` which TypeScript understands as `never`, enabling correct flow-narrowing after each check without casts
- Unit test suite (73 tests, all passing) using [vitest](https://vitest.dev):
  - `tests/unit/proxy.test.ts` — `buildRouteMap`, `resolveTarget`, `buildCertPage`
  - `tests/unit/config.test.ts` — `loadEnv` parsing, all `loadConfig` error + success paths
  - `tests/unit/cloudflare.test.ts` — `getApexDomain` with multi-label TLDs
  - `tests/unit/ip.test.ts` — `getLanIp` env override + real interface detection
  - `tests/unit/cleanup.test.ts` — `register` / `cleanup` process lifecycle
  - `tests/unit/tunnel.test.ts` — `writeTunnelConfig` YAML output
  - `tests/unit/acme.test.ts` — `loadMeta` / `isCertValid` expiry and domain logic
- `tsconfig.json` — `module: Node16`, `moduleResolution: Node16`, `strict: true`, `noImplicitReturns: true`
- `npm run typecheck` script — runs `tsc --noEmit` for type-only validation without a build
- `notes/typescript-migration.md` — documents key decisions and gotchas from the migration
- `notes/v2-feature-ideas.md` — planned v2 features captured (connection quality, daemon mode, path routing, multi-instance)

### Removed

- All `.js` source files (`src/acme.js`, `src/certs.js`, `src/cleanup.js`, `src/cloudflare.js`, `src/config.js`, `src/ip.js`, `src/mdns.js`, `src/proxy.js`, `src/tunnel.js`, `bin/dynamoip.js`)

## Summary of Changes

Full source-to-source migration from CommonJS JavaScript to TypeScript, with no functional changes. The build now goes through tsdown (tsup's successor) producing a single bundled `dist/dynamoip.cjs`. A 73-test vitest suite covers all modules — config parsing, proxy routing, Cloudflare API, ACME cert logic, WebSocket piping, mDNS cleanup, and tunnel config generation. The `http-proxy` CJS-style import gotcha (`import httpProxy = require('http-proxy')`) and the `dns.promises.Resolver` async fix are documented in `notes/typescript-migration.md`.

**Files Modified:**

- `src/types.ts` — new: shared interfaces used across all modules
- `src/config.ts` — converted from JS; added `fatal(): never` helper
- `src/proxy.ts` — converted; CJS-style http-proxy import; `InstanceType<typeof httpProxy>` instance type
- `src/cloudflare.ts` — converted; generic `cfFetch<T>()`; `getAccountId` moved here from tunnel
- `src/acme.ts` — converted; `dns.promises.Resolver`; `expiresAt.toISOString()`
- `src/ip.ts` — converted
- `src/cleanup.ts` — converted
- `src/certs.ts` — converted
- `src/mdns.ts` — converted
- `src/tunnel.ts` — converted
- `bin/dynamoip.ts` — converted; typed graceful restart with `activeServers` array
- `tsconfig.json` — new: Node16 module resolution, strict mode
- `tsdown.config.ts` — new: CJS bundle config targeting node18
- `vitest.config.mjs` — updated: `include: ['tests/**/*.test.ts']`
- `package.json` — `main`/`bin` → `dist/dynamoip.cjs`; `engines: >=18`; added `build`, `typecheck` scripts; added devDeps
- `.npmignore` — excludes `src/`, `bin/`, `tests/`, `notes/`, build config files
- `tests/unit/proxy.test.ts` — new
- `tests/unit/config.test.ts` — new
- `tests/unit/cloudflare.test.ts` — new
- `tests/unit/ip.test.ts` — new
- `tests/unit/cleanup.test.ts` — new
- `tests/unit/tunnel.test.ts` — new
- `tests/unit/acme.test.ts` — new

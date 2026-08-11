# 01 — Multi-instance support via control-plane / data-plane split

## Goal

Make it safe to invoke `dynamoip` from multiple projects on the same host without ports 80/443 colliding. The first instance to start owns the listening sockets (data plane) and exposes a local IPC control plane; subsequent invocations detect it, push their routes over IPC, and either exit or stay alive as heartbeat clients. Solves: today, the second `dynamoip` to start dies with `EADDRINUSE` because only one process can bind a TCP port on a host.

Reference incident: nabh_assessment dockerized stack (May 2026). A host-resident `dynamoip` from another project (`besocial/neuron`) held :80/:443, so the containerized `dynamoip` for nabhdev couldn't bind. Same constraint applies on a production server where multiple compose stacks share one host.

## Why a control plane (vs. just running one shared dynamoip)

You can already work around this today by running one dynamoip per host with a multi-subdomain config. That works but it has real downsides:

- Adding/removing a service requires editing a central config and restarting the daemon — interrupts all routed traffic.
- The central config has to know about every project's subdomain + port. Each project loses self-containment.
- No graceful behaviour when a project's containers go down: the route stays in the config pointing at a dead upstream.

A control plane gives each project local ownership of its own routes while sharing the one process that holds the sockets. It also unlocks docker-label auto-discovery later (Phase 3).

## What today's code prevents

- `src/proxy.ts:startProxy()` hard-binds `0.0.0.0:443` (and `:80` for the redirect server). Two processes on one host can never both do this — kernel constraint, not a code one. `SO_REUSEPORT` does not help here (it load-balances connections; it doesn't merge routing tables).
- `src/proxy.ts:buildRouteMap()` is called once at startup and returns a `const Map`. There is no API to add a route after `server.listen()` has fired.
- `bin/dynamoip.ts:main()` unconditionally tries to claim ports, request ACME certs, and write Cloudflare DNS records. There is no "attach if existing instance" branch.
- `src/acme.ts` issues a SAN cert covering exactly the subdomains in the config at startup. Adding a new subdomain at runtime would require re-issuing the cert — and hitting LE rate limits if many projects spin up sequentially.

## Implementation plan

Three phases. Phase 1 is the minimum viable change. Phases 2 and 3 are ergonomic improvements on top.

### Phase 1 — minimum viable attach (control plane + dynamic routes + wildcard cert)

#### Files to create

- `src/control.ts` — Unix-socket HTTP server (control plane).
- `src/state.ts` — Persisted route store (`~/.dynamoip/state.json` or `/var/lib/dynamoip/state.json`).
- `src/client.ts` — Client helpers used by the "attach" code path in `bin/dynamoip.ts`.

#### Files to modify

- `bin/dynamoip.ts` — Add attach-or-bind startup branch, `--attach` and `--standalone` flags.
- `src/proxy.ts` — Replace `const RouteMap` with a mutable `RouteStore` exposing `add(host, target, leaseId)` / `remove(leaseId)` / `snapshot()`. Keep the public proxy contract the same; the lookup in `resolveTarget` is still O(1).
- `src/acme.ts` — Request a wildcard cert (`*.<baseDomain>`) instead of a SAN cert. DNS-01 is already in use, which is required for wildcards.
- `src/types.ts` — Add `Lease`, `RouteRegistration`, `ControlSocketPath`.

#### Control plane API

Listen on a Unix socket — default `/var/run/dynamoip.sock` on Linux, `${XDG_RUNTIME_DIR:-/tmp}/dynamoip.sock` on macOS (varies; pick one and document). File-permission auth (`chmod 0600`, owner-only). No API key needed.

Endpoints (JSON over HTTP):

| Verb | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/routes` | `{ name, baseDomain?, target, ttlSeconds }` | `{ id, expiresAt }` |
| `PUT` | `/routes/:id/heartbeat` | — | `{ expiresAt }` |
| `DELETE` | `/routes/:id` | — | `204` |
| `GET` | `/routes` | — | `[{ id, name, baseDomain, target, expiresAt }]` |
| `GET` | `/healthz` | — | `{ ok: true, version, baseDomain, uptimeSeconds }` |

`target` is `host:port`. The daemon validates that it can connect to it on register; reject `EHOSTUNREACH` with a 400 so the client knows immediately.

#### Attach-or-bind startup logic (in `bin/dynamoip.ts`)

Pseudocode replacing the top of `main()`:

```ts
const sockPath = resolveSocketPath(); // platform-specific
const existing = await probeDaemon(sockPath); // GET /healthz

if (existing && !args.includes('--standalone')) {
  // Compatibility check — refuse if baseDomain disagrees.
  if (existing.baseDomain !== config.baseDomain) {
    fatal(`Existing dynamoip on this host owns baseDomain="${existing.baseDomain}", `
        + `cannot register routes under "${config.baseDomain}"`);
  }

  const client = createClient(sockPath);
  const leaseIds = await Promise.all(
    config.domains.map(d =>
      client.register({ name: d.name, baseDomain: config.baseDomain,
                        target: `${TARGET_HOST}:${d.targetPort}`,
                        ttlSeconds: 90 })
    )
  );

  if (args.includes('--once')) process.exit(0); // CI / scripted use

  // Stay alive as a heartbeat client. Daemon evicts our routes if we die.
  startHeartbeatLoop(client, leaseIds, 30_000);
  installSignalHandlers(client, leaseIds);
  return; // never falls through to the daemon path
}

if (args.includes('--attach')) {
  fatal('No running dynamoip daemon found and --attach was specified. Aborting.');
}

// Become the daemon.
const lockReleased = await claimSocket(sockPath); // bind + chmod 0600 + write PID
await runDaemon(config, lockReleased);
```

`claimSocket` must `unlink` a stale socket if its writing PID is dead (handles unclean shutdown).

#### Lease-based liveness

Each route carries `expiresAt`. A daemon-side sweeper runs every 5s; routes past `expiresAt + grace` are removed and logged. Default TTL 90s, heartbeat every 30s → tolerates one missed heartbeat. No graceful unregister required — process death is enough, the route disappears within ~95s.

If clients want clean removal, the signal handler should `DELETE /routes/:id` for each owned lease before exit.

#### Dynamic route map

Replace the closure-scoped `routeMap` in `src/proxy.ts` with a `RouteStore` class:

```ts
class RouteStore {
  private byHost = new Map<string, RouteEntry>();
  private byLeaseId = new Map<string, string>(); // leaseId -> host

  add(host: string, target: string, leaseId: string, expiresAt: number) { /* ... */ }
  remove(leaseId: string) { /* ... */ }
  resolve(host: string): string | null { /* same as today */ }
  snapshot(): RouteEntry[] { /* for /routes + persistence */ }
  sweepExpired(now: number): RouteEntry[] { /* returns evicted entries for logging */ }
}
```

The proxy's `request` and `upgrade` handlers call `store.resolve(host)` exactly as they call `routeMap.get(bare)` today. The only structural change is that the store is mutable.

Lock-free is fine — Node is single-threaded; all mutations happen on the event loop.

#### Wildcard cert

In `src/acme.ts`:

- Change the order from SAN-on-listed-subdomains to a single identifier `*.${baseDomain}`.
- DNS-01 challenge is the only valid challenge for wildcards (already in use).
- Renew the cert when 30 days from expiry, same as today. New subdomains do not trigger a renewal.

Tradeoff: a wildcard cert is presented for any `*.baseDomain`, not just the registered ones. For a private LAN setup that's fine. If a stricter SAN cert is needed, fall back to "re-issue when the route set changes, with a debounce of 60s to coalesce multi-project startups."

#### Persistence

`src/state.ts` writes the route snapshot to disk on every `add` / `remove` / `sweep`. Atomic via tmp-file + rename. On daemon startup, load it back so a planned restart doesn't drop routes before clients re-register.

Path: `${XDG_STATE_HOME:-~/.local/state}/dynamoip/routes.json` (or `/var/lib/dynamoip/routes.json` if running as root).

### Phase 2 — Docker ergonomics

Goal: stop running dynamoip inside per-project compose files. One host-level dynamoip; each project ships a tiny register-sidecar.

#### Files to create

- `docker/sidecar/Dockerfile` — tiny image (node:22-alpine + the compiled `dist/dynamoip.cjs`) that only runs `dynamoip register-sidecar ...`.
- `docker/systemd/dynamoip.service` — host-level unit running the daemon.
- `docs/multi-instance.md` — sidecar wiring guide.

#### New bin subcommand

`bin/dynamoip.ts register-sidecar`:

- Reads env vars `DYNAMOIP_SOCKET`, `DYNAMOIP_DOMAINS` (e.g. `nabhdev:3000,api:4000`), `DYNAMOIP_BASE_DOMAIN`, `DYNAMOIP_TARGET_HOST`.
- POSTs each `(name, target)` to the daemon's control socket.
- Heartbeats forever. On SIGTERM, gracefully `DELETE` each lease and exit 0.
- No port binding, no cert handling, no Cloudflare touching — pure client.

#### Project-side compose snippet

```yaml
services:
  dynamoip-register:
    image: foundanand/dynamoip:1.1.0
    command: register-sidecar
    environment:
      DYNAMOIP_SOCKET: /var/run/dynamoip.sock
      DYNAMOIP_BASE_DOMAIN: bhattargroup.com
      DYNAMOIP_DOMAINS: "nabhdev:3000"
      DYNAMOIP_TARGET_HOST: nabh-app-1   # service name on shared docker network
    volumes:
      - /var/run/dynamoip.sock:/var/run/dynamoip.sock
    networks: [edge]
    restart: unless-stopped
```

The shared `edge` network must already exist on the host (`docker network create edge`) and the host dynamoip must be attached to it so the daemon can reach upstream containers by service name.

### Phase 3 — Docker-label auto-discovery (optional)

Like Traefik. Daemon watches `/var/run/docker.sock` for `container start` / `container die` events. Containers labeled with:

```
dynamoip.enable=true
dynamoip.domain=nabhdev
dynamoip.port=3000
```

are auto-registered on start and removed on stop. Replaces the register-sidecar entirely.

#### Files to add

- `src/docker-discovery.ts` — ~150 LOC using `dockerode`. Off by default; opt in with `--watch-docker` or `DYNAMOIP_WATCH_DOCKER=1`.

#### Tradeoffs

- Daemon needs read access to the docker socket — a real privilege escalation if the daemon is compromised.
- Container target IP discovery: pick the IP on the shared `edge` network. Reject ambiguous matches.

Skip Phase 3 if the docker-socket dependency is not acceptable.

## Open questions

- **Socket path on macOS.** `/var/run` is read-only on modern macOS. Pick one: `${TMPDIR}/dynamoip.sock` (per-user), `~/.dynamoip/control.sock` (per-user), or a documented `--socket` flag.
- **Cross-host:** what if two hosts on the LAN both run dynamoip with the same `baseDomain`? Today they fight over Cloudflare DNS A records. Out of scope for this todo — flag a follow-up.
- **Auth between client and daemon.** File permission `0600` is enough for local-only IPC. If anyone wants remote control, that's a separate feature requiring real auth.
- **Wildcard cert vs strict SAN.** Default to wildcard. Add an opt-in `strictCert: true` config field that triggers SAN re-issuance on route changes, debounced to 60s.

## Verification

```bash
# Phase 1
cd /Users/foundanand/Developer/foundanand/devtools/dynamoip
npm run build

# Daemon claims sockets
sudo node dist/dynamoip.cjs --config example-config.json &
DAEMON=$!
sleep 2
test -S /var/run/dynamoip.sock     # socket exists
curl --unix-socket /var/run/dynamoip.sock http://localhost/healthz
# Expect: { ok: true, baseDomain: "...", uptimeSeconds: ... }

# Second invocation attaches instead of failing
node dist/dynamoip.cjs --config second-config.json &
SECOND=$!
sleep 2
curl --unix-socket /var/run/dynamoip.sock http://localhost/routes
# Expect: routes from BOTH configs

# Client death evicts its routes
kill $SECOND
sleep 95   # past TTL + grace
curl --unix-socket /var/run/dynamoip.sock http://localhost/routes
# Expect: only the daemon's original routes remain

# --attach refuses without a daemon
kill $DAEMON
sleep 2
node dist/dynamoip.cjs --attach --config any.json
# Expect: exit 1, "No running dynamoip daemon found"
```

Tests to add under `tests/`:

- `tests/control.test.ts` — control-plane endpoints, lease TTL, sweep correctness.
- `tests/attach.test.ts` — startup branching (claim vs attach vs --standalone vs --attach).
- `tests/store.test.ts` — `RouteStore` mutation + lookup + persistence round-trip.

## Pre-commit checklist (project convention)

When this lands, the dynamoip `CLAUDE.md` pre-commit checklist requires:

- [ ] `package.json` version bump (minor — new feature).
- [ ] `CHANGELOG.md` entry under the new version.
- [ ] `README.md` updated: new "Multi-instance" section, `--attach` / `--standalone` flags, `register-sidecar` subcommand if Phase 2 lands.
- [ ] `llms.txt` mirror of the README changes.
- [ ] `docs/docker.md` updated if Phase 2 ships.
- [ ] `--help` text in `bin/dynamoip.ts` lists the new flags.
- [ ] `src/config.ts` validates any new config field with a clear error message.
- [ ] `.env.example` updated if any env var (`DYNAMOIP_SOCKET`, `DYNAMOIP_WATCH_DOCKER`, …) is introduced.

## Out of scope

- High availability across hosts. One daemon per host is the contract.
- Authenticated remote control plane.
- Phase 3 auto-discovery if the docker-socket privilege escalation is unacceptable.
- TLS termination strategies other than wildcard / SAN ACME (e.g. SNI passthrough).

## Sizing estimate

Phase 1 alone: ~500-800 LOC across `bin/dynamoip.ts`, `src/control.ts`, `src/state.ts`, `src/client.ts`, `src/proxy.ts`, `src/acme.ts`, plus tests. Not a one-evening change. Phase 2 adds ~150 LOC and the sidecar image. Phase 3 adds ~150 LOC if pursued.

# dynamoip v2 — Feature Ideas

## 1. Connection Quality Feedback

Give users visibility into how fast/stable their connection is.

**Beginner-facing:**
- A single `quality: 8/10` score shown at startup and updated periodically
- Score derived from tunnel RTT + slow-request percentage

**Advanced-facing:**
- Tunnel RTT ping printed after Max mode tunnel is established (e.g. `tunnel RTT: 42ms`)
- Per-request timing logged on every proxied request
- `[SLOW 2.3s] GET /api/data` warning when a request exceeds a threshold (~2s)
- Periodic stats summary (every ~30s or on keypress `s`): `142 req | avg 45ms | p95 210ms | quality 7/10`

**Score bands (suggested):**
| Score | RTT |
|-------|-----|
| 9–10  | < 50ms |
| 7–8   | 50–150ms |
| 5–6   | 150–300ms |
| < 5   | degraded |

---

## 2. Daemon Mode (`-d` flag)

Run dynamoip in the background without keeping a terminal open, similar to `docker run -d`.

**How it works:**
- `dynamoip -d` spawns a detached Node child process (`stdio: 'ignore'`, `unref()`) then exits the parent
- Output is redirected to a per-instance log file

**Per-instance identity:**
- PID file: `~/.localmap/dynamoip-<name>.pid` (keyed by project/config)
- Log file: `~/.localmap/logs/dynamoip-<name>.log`

**Companion commands needed:**
| Command | Behaviour |
|---------|-----------|
| `dynamoip stop` | Kill daemon for current project (via PID file) |
| `dynamoip status` | List all running instances with uptime + tunnel URL |
| `dynamoip logs` | Tail the current project's log file (like `docker logs -f`) |
| `dynamoip stop --all` | Kill all running instances |

**Edge cases:**
- Running `-d` when already running: warn and exit (or `--force` to restart)
- Instance name derived from config path so different projects don't collide

---

## 3. Multi-Instance Support

Multiple dynamoip instances can run across different projects simultaneously.

**Flows from daemon mode design** — each instance is identified by its config directory, not a global singleton.

- `dynamoip status` (run anywhere) shows all running instances
- `dynamoip stop` in a project dir stops only that project's daemon

---

## 4. Path-Based Routing

Support routing by URL path prefix in addition to subdomain, and support the apex domain itself as a target.

**What changes:**
- Proxy routing table becomes `host + path prefix → target` instead of `host → target`

**Apex domain support:**
- `domain.com` (no subdomain) routes to a service
- DNS: already uses A records so apex works; no change needed
- SSL cert must explicitly include apex — wildcard `*.domain.com` does NOT cover bare `domain.com` by spec

**Path routing:**
- `app.domain.com/test1` → service A
- `app.domain.com/test2` → service B
- Default behaviour: strip the path prefix before forwarding (configurable per-route)

**Config shape (proposed):**
```json
{
  "baseDomain": "domain.com",
  "routes": [
    { "host": "domain.com", "target": 3000 },
    { "host": "app.domain.com", "path": "/test1", "target": 3001, "stripPath": true },
    { "host": "app.domain.com", "path": "/test2", "target": 3002, "stripPath": true }
  ]
}
```

**Open questions:**
- Backwards compatibility with existing `domains: { name: port }` shorthand?
- Trailing slash normalisation for path matching

---

## 5. Database Proxying (TCP) — Deferred

Expose databases (Postgres, MySQL, Redis, MongoDB) via TCP tunnel — not just HTTP.

**Why deferred:** requires a TCP proxy layer alongside the existing HTTP proxy, and security needs to be first-class (access control, IP allowlist, or Cloudflare Access). Too risky to ship without a solid auth story.

**When revisiting, decide:**
- Which databases are in scope
- Use case: dev team sharing a local DB, or closer to production?
- Security model: IP allowlist, credentials layer, or Cloudflare Access (Max mode only)?
- Should the connection string work transparently or require client-side config?

---

## 6. TypeScript Migration

Convert entire codebase from CommonJS JavaScript to TypeScript.

**Status:** In progress — see conversion plan in `notes/typescript-migration.md`

**Why now (before other features):**
- Config schema is about to get significantly more complex (path routing, daemon state)
- Types catch mismatches between modules at compile time
- New features should be written in TypeScript from the start

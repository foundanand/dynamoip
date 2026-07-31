# Running dynamoip in Docker

This guide explains how to run dynamoip inside a Docker container, including the extra step required on macOS and Windows.

---

## Why Docker needs special handling on macOS and Windows

When dynamoip starts, it detects your machine's LAN IP to register DNS records and start the proxy. On a bare machine this works automatically — `os.networkInterfaces()` returns the real network interfaces.

Inside a Docker container the situation changes by platform:

**Linux** — Docker supports `--network: host`, which makes the container share the host's network stack. `os.networkInterfaces()` sees the real interfaces and auto-detection works with no extra config.

**macOS and Windows** — `--network: host` is not supported (Docker Desktop runs containers inside a Linux VM). The container only sees virtual interfaces (e.g. `172.17.0.2`), not the host's actual LAN IP. Auto-detection returns the wrong address.

`host.docker.internal` does not solve this either — it resolves to the Docker Desktop VM's bridge IP (e.g. `192.168.65.2`), not the LAN IP your router assigned to your machine.

The solution is to pass the LAN IP explicitly via the `LAN_IP` environment variable.

---

## The `LAN_IP` environment variable

When `LAN_IP` is set, dynamoip uses it directly and skips auto-detection. When it is unset, auto-detection runs as normal (correct on Linux; incorrect inside Docker on macOS/Windows).

```env
LAN_IP=192.168.1.42
```

---

## docker-compose setup

Pass `LAN_IP` through to the dynamoip service using the `${LAN_IP:-}` syntax. This means: use the value if set in the host environment, otherwise pass nothing (so auto-detection runs on Linux where `LAN_IP` is left unset).

```yaml
services:
  dynamoip:
    image: your-dynamoip-image
    network_mode: host          # Linux only — remove on macOS/Windows
    environment:
      LAN_IP: ${LAN_IP:-}
      CF_API_TOKEN: ${CF_API_TOKEN}
      CF_EMAIL: ${CF_EMAIL:-}
    volumes:
      - ./dynamoip.config.json:/app/dynamoip.config.json:ro
      - dynamoip-certs:/root/.localmap/certs

volumes:
  dynamoip-certs:
```

> On macOS and Windows, remove `network_mode: host` — it is not supported and will cause an error.

---

## Finding your LAN IP

You need to find the IP your router assigned to your machine, then set it as `LAN_IP` before starting Docker.

**macOS:**
```bash
ipconfig getifaddr en0         # Wi-Fi
ipconfig getifaddr en1         # Ethernet (if applicable)
```

Or, to detect it automatically from the default route:
```bash
route -n get default | awk '/interface:/{print $2}' | xargs ipconfig getifaddr
```

**Linux:**
```bash
ip route get 1 | awk '{print $7; exit}'
```

**Windows (PowerShell):**
```powershell
(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric |
    Select-Object -First 1 | Get-NetIPAddress -AddressFamily IPv4).IPAddress
```

---

## Recommended: auto-detect with a startup script

Instead of manually setting `LAN_IP` every time, use a startup script that detects it from the host and injects it before calling `docker compose up`. This way, if your IP changes (DHCP reassignment, switching networks), you just re-run the script and everything picks up the new address automatically.

**macOS/Linux (`start.sh`):**
```bash
#!/bin/bash
IFACE=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
export LAN_IP=$(ipconfig getifaddr "$IFACE" 2>/dev/null)

# Linux fallback
if [ -z "$LAN_IP" ]; then
  export LAN_IP=$(ip route get 1 2>/dev/null | awk '{print $7; exit}')
fi

echo "LAN_IP=$LAN_IP"
docker compose up "$@"
```

**Windows (`start.ps1`):**
```powershell
$env:LAN_IP = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' |
    Sort-Object RouteMetric | Select-Object -First 1 |
    Get-NetIPAddress -AddressFamily IPv4).IPAddress

Write-Host "LAN_IP=$($env:LAN_IP)"
docker compose up
```

Run `./start.sh` (or `.\start.ps1`) instead of `docker compose up` directly.

---

## Linux: no extra config needed

On Linux, use `--network: host` in your docker-compose and leave `LAN_IP` unset. dynamoip will auto-detect the LAN IP inside the container just as it does when running bare on the host.

```yaml
services:
  dynamoip:
    network_mode: host
    environment:
      CF_API_TOKEN: ${CF_API_TOKEN}
```

---

## Max mode (Cloudflare Tunnel) in Docker

Max mode has different requirements from Pro/Quick mode:

- **No `LAN_IP` needed** — Max mode doesn't create DNS A records, so there's no IP to advertise.
- **`TARGET_HOST` needed on macOS/Windows** — the proxy forwards to `localhost:{port}` by default, but inside a container `localhost` is the container itself. Set `TARGET_HOST=host.docker.internal` so the proxy reaches services running on the host machine.
- **Linux with `network_mode: host`** — `localhost` resolves to the host, so `TARGET_HOST` is not needed.
- **`cloudflared` must be in the image** — the auto-install logic (brew/curl) won't work inside most containers. Install it in your Dockerfile instead:

```dockerfile
ARG TARGETARCH=amd64
RUN curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH} \
    -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
```

- **Set a fixed `hostname` (bridge networking only)** — tunnels are named
  `dynamoip-{baseDomain}-{hostname}`, and a container's default hostname is its ID, which changes on
  every recreate. Without a fixed `hostname:`, each `docker compose up --force-recreate` creates a
  brand-new tunnel and leaves the previous one orphaned. Pin it as in the macOS/Windows example below.
  With `network_mode: host` you must **not** set `hostname:` — Docker rejects the combination, and
  host networking already gives the container the host's own stable hostname.

- **Persist `~/.localmap/tunnels`** — the named volume in the examples below keeps the credentials
  file across recreates. Without it the credentials are re-fetched from Cloudflare on every start,
  which works but makes an extra API call each time.

### docker-compose for Max mode (macOS/Windows)

```yaml
services:
  dynamoip:
    build: .
    hostname: dynamoip                    # fixed — tunnel name depends on it
    environment:
      CF_API_TOKEN: ${CF_API_TOKEN}
      TARGET_HOST: host.docker.internal   # forward to services on the host
    volumes:
      - ./dynamoip.config.json:/app/dynamoip.config.json:ro
      - dynamoip-tunnels:/root/.localmap/tunnels
    extra_hosts:
      - host.docker.internal:host-gateway  # ensures host.docker.internal resolves

volumes:
  dynamoip-tunnels:
```

### docker-compose for Max mode (Linux)

```yaml
services:
  dynamoip:
    build: .
    network_mode: host   # localhost inside container = host localhost
    environment:         # no `hostname:` — host networking already supplies the host's
      CF_API_TOKEN: ${CF_API_TOKEN}   # stable hostname, and Docker rejects both together
    volumes:
      - ./dynamoip.config.json:/app/dynamoip.config.json:ro
      - dynamoip-tunnels:/root/.localmap/tunnels

volumes:
  dynamoip-tunnels:
```

---

## Summary

| Platform | Mode | `network_mode` | `LAN_IP` needed? | `TARGET_HOST` needed? |
|---|---|---|---|---|
| Linux | Pro/Quick | `host` | No — auto-detected | No |
| macOS | Pro/Quick | *(omit)* | Yes | No |
| Windows | Pro/Quick | *(omit)* | Yes | No |
| Linux | Max | `host` | No | No |
| macOS | Max | *(omit)* | No | Yes — `host.docker.internal` |
| Windows | Max | *(omit)* | No | Yes — `host.docker.internal` |

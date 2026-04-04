'use strict';

const http  = require('http');
const https = require('https');
const net   = require('net');
const fs    = require('fs');
const httpProxy = require('http-proxy');

function buildCertPage(certUrl, domains, proxyPort) {
  const portSuffix = proxyPort === 443 ? '' : `:${proxyPort}`;
  const links = domains.map(d =>
    `<li><a href="https://${d.name}.local${portSuffix}">${d.name}.local</a></li>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>dynamoip — Trust Setup</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           max-width: 520px; margin: 3rem auto; padding: 0 1.5rem; color: #1a1a1a; }
    h1   { font-size: 1.3rem; margin-bottom: .25rem; }
    p    { color: #555; font-size: .9rem; margin: .5rem 0 1.5rem; }
    .btn { display:inline-block; background:#1a1a1a; color:#fff; padding:12px 24px;
           border-radius:8px; text-decoration:none; font-size:1rem; margin-bottom:2rem; }
    details { margin-bottom: .75rem; border:1px solid #e5e5e5; border-radius:6px; padding:.75rem 1rem; }
    summary { cursor:pointer; font-weight:600; font-size:.875rem; }
    ol  { margin:.75rem 0 0 1.25rem; font-size:.85rem; line-height:1.8; color:#333; }
    hr  { border:none; border-top:1px solid #e5e5e5; margin:1.5rem 0; }
    ul  { padding:0; list-style:none; }
    ul li a { color:#6366f1; font-size:.9rem; }
  </style>
</head>
<body>
  <h1>dynamoip — Trust Setup</h1>
  <p>Install the CA certificate on this device to access .local domains over HTTPS without warnings.</p>

  <a class="btn" href="/dynamoip-ca.crt">Download CA Certificate</a>

  <details open>
    <summary>iOS / iPadOS</summary>
    <ol>
      <li>Tap <strong>Download CA Certificate</strong> above</li>
      <li>Go to <strong>Settings → General → VPN &amp; Device Management</strong></li>
      <li>Tap the downloaded profile → <strong>Install</strong></li>
      <li>Go to <strong>Settings → General → About → Certificate Trust Settings</strong></li>
      <li>Enable full trust for <em>dynamoip</em></li>
    </ol>
  </details>

  <details>
    <summary>Android</summary>
    <ol>
      <li>Tap <strong>Download CA Certificate</strong> above</li>
      <li>Go to <strong>Settings → Security → Encryption &amp; credentials</strong></li>
      <li>Tap <strong>Install a certificate → CA Certificate</strong></li>
      <li>Select the downloaded file</li>
    </ol>
  </details>

  <details>
    <summary>macOS</summary>
    <ol>
      <li>Click <strong>Download CA Certificate</strong> above</li>
      <li>Open <strong>Keychain Access</strong>, drag the file into <em>System</em> keychain</li>
      <li>Double-click it → <strong>Trust → Always Trust</strong></li>
    </ol>
  </details>

  <details>
    <summary>Windows</summary>
    <ol>
      <li>Click <strong>Download CA Certificate</strong> above</li>
      <li>Double-click the file → <strong>Install Certificate</strong></li>
      <li>Choose <strong>Local Machine</strong> → <strong>Trusted Root Certification Authorities</strong></li>
    </ol>
  </details>

  <hr/>
  <p style="font-size:.8rem;color:#888">Available domains on this network:</p>
  <ul>${links}</ul>
</body>
</html>`;
}

function buildRouteMap(domains, baseDomain) {
  const map = new Map();
  const targetHost = process.env.TARGET_HOST || 'localhost';
  for (const { name, targetPort } of domains) {
    const target = `http://${targetHost}:${targetPort}`;
    map.set(`${name}.local`, target);
    map.set(name, target);
    if (baseDomain) map.set(`${name}.${baseDomain}`, target);
  }
  return map;
}

function resolveTarget(routeMap, host) {
  if (!host) return null;
  const bare = host.split(':')[0].toLowerCase();
  return routeMap.get(bare) || null;
}

function makeRequestHandler(routeMap, proxy, domains) {
  return (req, res) => {
    const target = resolveTarget(routeMap, req.headers.host);
    if (target) {
      proxy.web(req, res, { target });
    } else {
      const host = req.headers.host || '';
      const configured = [...new Set(domains.map(d => `${d.name}.local`))];
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Not Found',
        message: `No service configured for "${host}"`,
        configured,
      }));
    }
  };
}

function startProxy(domains, proxyPort, sslOpts, bindHost = '0.0.0.0', baseDomain = null) {
  const routeMap = buildRouteMap(domains, (sslOpts && sslOpts.baseDomain) || baseDomain);
  const proxy = httpProxy.createProxyServer({ xfwd: true });

  // Rate-limit identical proxy error messages (same host + message) to once per 5s
  const errorLoggedAt = new Map();
  proxy.on('error', (err, req, res) => {
    const host = req.headers.host || 'unknown';
    const key  = `${host}:${err.message}`;
    const now  = Date.now();
    if (!errorLoggedAt.has(key) || now - errorLoggedAt.get(key) > 5000) {
      console.error(`[proxy] Error forwarding ${host}: ${err.message}`);
      errorLoggedAt.set(key, now);
    }
    // When the error comes from a WebSocket proxy, `res` is a net.Socket, not
    // an http.ServerResponse — it has no writeHead(). Destroy it instead.
    if (typeof res.writeHead !== 'function') {
      res.destroy();
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    }
  });

  const handler = makeRequestHandler(routeMap, proxy, domains);
  let server;
  let redirectServer = null;

  if (sslOpts) {
    const credentials = {
      cert: fs.readFileSync(sslOpts.certFile),
      key:  fs.readFileSync(sslOpts.keyFile),
    };
    server = https.createServer(credentials, handler);

    // HTTP server: landing page + CA cert download + HTTPS redirect
    const redirectPort = sslOpts.redirectPort || 80;
    redirectServer = http.createServer((req, res) => {
      const host = (req.headers.host || '').split(':')[0];
      const portSuffix = proxyPort === 443 ? '' : `:${proxyPort}`;
      res.writeHead(301, { Location: `https://${host}${portSuffix}${req.url}` });
      res.end();
    });
    redirectServer.listen(redirectPort, () => {
      console.log(`  HTTP  :${redirectPort}  -> redirects to HTTPS`);
    });
    redirectServer.on('error', (err) => {
      if (err.code === 'EACCES') {
        console.warn(`  Note: could not bind HTTP redirect on port ${redirectPort} (run with sudo to enable)`);
      } else if (err.code !== 'EADDRINUSE') {
        console.warn(`  HTTP redirect error: ${err.message}`);
      }
    });
  } else {
    server = http.createServer(handler);
  }

  // WebSocket support (Vite HMR, Next.js Fast Refresh, etc.)
  // http-proxy's ws() has a race condition with fast upstream servers (e.g.
  // Next.js Turbopack) that send WebSocket frames in the same TCP packet as
  // the 101 response — the HTTP parser sees binary frame bytes before the
  // 'upgrade' event fires and throws "Parse Error: Expected HTTP/".
  // Raw TCP piping bypasses the parser entirely and works with any upstream.
  server.on('upgrade', (req, socket, head) => {
    const target = resolveTarget(routeMap, req.headers.host);
    if (!target) { socket.destroy(); return; }

    const targetUrl = new URL(target);
    const port = parseInt(targetUrl.port) || 80;
    const host = targetUrl.hostname;

    // Rebuild the upgrade request, rewriting Host and Origin to the upstream
    // address. Next.js 15+ rejects WS upgrades where Origin doesn't match the
    // dev server host — the browser sends the proxy domain as Origin, which
    // fails Next.js's CSRF check for HMR connections.
    const headers = Object.assign({}, req.headers, {
      host:   `${host}:${port}`,
      origin: `http://${host}:${port}`,
    });
    const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    const upgradeReq = `${req.method} ${req.url} HTTP/1.1\r\n${headerStr}\r\n\r\n`;

    const upstream = net.connect(port, host, () => {
      upstream.write(upgradeReq);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.on('error', (err) => {
    if (err.code === 'EACCES') {
      console.error(`\nPermission denied on port ${proxyPort}.`);
      console.error(`Run with sudo, or set a higher port in your config.\n`);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${proxyPort} is already in use.\n`);
    } else {
      console.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(proxyPort, bindHost, () => {
    const proto = sslOpts ? 'HTTPS' : 'HTTP';
    const host  = bindHost === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
    console.log(`  ${proto} ${host}:${proxyPort}  -> proxying by Host header`);
  });

  return { server, redirectServer };
}

module.exports = { startProxy };

# Using dynamoip in local development

This guide covers installing dynamoip as a dev dependency in your project and running it alongside your dev server.

---

## 1. Install dynamoip

**npm:**
```bash
npm install --save-dev dynamoip
```

**pnpm:**
```bash
pnpm add -D dynamoip
```

**yarn:**
```bash
yarn add -D dynamoip
```

> **Why a dev dependency?** dynamoip is a local development tool — it never runs in production. Installing it as a `devDependency` keeps it out of your production bundle.

---

## 2. Add a config file

Create `dynamoip.config.json` at the root of your project:

```json
{
  "baseDomain": "yourdomain.com",
  "domains": {
    "myapp": 3000
  }
}
```

For Quick mode (no domain needed), omit `baseDomain`:

```json
{
  "domains": {
    "myapp": 3000
  }
}
```

Add it to `.gitignore` if it contains a real domain you don't want committed:

```gitignore
dynamoip.config.json
```

Or commit it if your team shares the same domain setup — it contains no secrets (credentials go in `.env`, not the config).

See the [configuration reference](../README.md#configuration-reference) for all options.

---

## 3. Add scripts to package.json

```json
"scripts": {
  "dev": "next dev",
  "dev:proxy": "dynamoip --config dynamoip.config.json",
  "dev:full": "concurrently \"npm run dev\" \"sudo npm run dev:proxy\""
}
```

> **Note:** `dev:proxy` does not include `sudo` in the script itself — pass `sudo` when you invoke it (see Step 4). This keeps the script portable across environments.

If you use `dev:full`, install `concurrently` first:

**npm:** `npm install --save-dev concurrently`
**pnpm:** `pnpm add -D concurrently`
**yarn:** `yarn add -D concurrently`

---

## 4. Run the proxy

Package managers add `node_modules/.bin` to PATH when running scripts, so the `dynamoip` binary is always found — even without a global install. Always invoke via your package manager, not bare `sudo dynamoip`.

**npm:**
```bash
# Two terminals
npm run dev
sudo npm run dev:proxy

# Or together
npm run dev:full
```

**pnpm:**
```bash
# Two terminals
pnpm dev
sudo pnpm run dev:proxy

# Or together
pnpm run dev:full
```

**yarn:**
```bash
# Two terminals
yarn dev
sudo yarn dev:proxy

# Or together
yarn dev:full
```

> **Why `sudo`?** Binding to ports 80 and 443 requires root on macOS and Linux. Use `--port 8443` in your config to avoid sudo — your URLs will include the port number.

---

## 5. Add .env for Pro mode

If you are using Pro mode (Cloudflare + Let's Encrypt), create a `.env` file next to `dynamoip.config.json`:

```env
CF_API_TOKEN=your_cloudflare_api_token_here
CF_EMAIL=you@example.com
```

Make sure `.env` is in your `.gitignore`:

```gitignore
.env
.env.*
!.env.example
```

---

## Troubleshooting

**`sudo: dynamoip: command not found`**

Do not run `sudo dynamoip` directly — sudo uses a restricted PATH that doesn't include `node_modules/.bin`. Always run via your package manager:

```bash
sudo npm run dev:proxy
sudo pnpm run dev:proxy
sudo yarn dev:proxy
```

**`npm link` hangs (npm 7+)**

On projects with heavy native dependencies (Prisma, Sharp, esbuild), `npm link` can hang because npm 7+ runs a full install. Use `pnpm` or `yarn` instead, or install from the registry directly:

```bash
npm install --save-dev dynamoip
```

---

## Using a local source checkout (for dynamoip contributors)

If you are working on dynamoip itself and want to test changes in another project without publishing:

**npm** — use the `file:` protocol:
```bash
npm install --save-dev file:/path/to/dynamoip --legacy-peer-deps
```

**pnpm** — use a `file:` reference in `package.json`:
```json
"devDependencies": {
  "dynamoip": "file:/path/to/dynamoip"
}
```
Then run `pnpm install`.

**yarn** — use `yarn link`:
```bash
cd /path/to/dynamoip && yarn link
cd /path/to/your/app && yarn link dynamoip
```

Code changes in the dynamoip directory are reflected immediately. If you add a new dependency to dynamoip, re-run install in your app to pick it up.

To remove a local link later:
```bash
npm uninstall dynamoip       # npm / file: protocol
yarn unlink dynamoip         # yarn link
```

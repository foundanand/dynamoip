import fs from 'fs';
import path from 'path';
import type { Config, DomainEntry, CloudflareConfig } from './types';

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*$/i;

function fatal(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// Load .env from the same directory as the config file (or cwd).
// Only sets variables not already present in the environment.
export function loadEnv(dir: string): void {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const val =
      raw.length >= 2 && raw[0] === raw[raw.length - 1] && (raw[0] === '"' || raw[0] === "'")
        ? raw.slice(1, -1)
        : raw;
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

export function loadConfig(configPath: string): Config {
  const resolved = path.resolve(configPath);

  if (!fs.existsSync(resolved)) {
    fatal(`Config file not found: ${resolved}\nCreate a dynamoip.config.json with:\n  { "domains": { "myapp": 3000 } }`);
  }

  // Load .env from the config file's directory before reading env vars
  loadEnv(path.dirname(resolved));

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    fatal(`Failed to parse config: ${(e as Error).message}`);
  }

  // null = not specified; bin picks a mode-appropriate default (8080/443/80).
  // An explicit value here is honoured in every mode.
  let port: number | null = null;
  if (raw.port !== undefined) {
    if (!Number.isInteger(raw.port) || (raw.port as number) < 1 || (raw.port as number) > 65535) {
      fatal(`Invalid proxy port: ${raw.port}`);
    }
    port = raw.port as number;
  }

  if (!raw.domains || typeof raw.domains !== 'object' || Array.isArray(raw.domains)) {
    fatal('Config must have a "domains" object, e.g. { "myapp": 3000 }');
  }

  const domains: DomainEntry[] = [];
  const seenNames = new Set<string>();
  const seenPorts = new Set<number>();

  for (const [name, targetPort] of Object.entries(raw.domains as Record<string, unknown>)) {
    if (!DOMAIN_RE.test(name)) {
      fatal(`Invalid domain name "${name}". Use only letters, numbers, and hyphens.`);
    }
    if (!Number.isInteger(targetPort) || (targetPort as number) < 1 || (targetPort as number) > 65535) {
      fatal(`Invalid port for domain "${name}": ${targetPort}`);
    }
    if (seenNames.has(name.toLowerCase())) {
      fatal(`Duplicate domain name: ${name}`);
    }
    if (seenPorts.has(targetPort as number)) {
      fatal(`Duplicate target port: ${targetPort}`);
    }
    seenNames.add(name.toLowerCase());
    seenPorts.add(targetPort as number);
    domains.push({ name: name.toLowerCase(), targetPort: targetPort as number });
  }

  if (domains.length === 0) {
    fatal('No domains configured. Add at least one entry to "domains".');
  }

  let baseDomain: string | null = null;
  let cloudflare: CloudflareConfig | null = null;

  if (raw.baseDomain) {
    if (typeof raw.baseDomain !== 'string' || raw.baseDomain.split('.').length < 2) {
      fatal('"baseDomain" must be a string like "local.myteam.dev"');
    }
    const apiToken = process.env.CF_API_TOKEN;
    if (!apiToken) {
      fatal('CF_API_TOKEN is required when using baseDomain.\nAdd it to your .env file:\n  CF_API_TOKEN=your_token_here');
    }
    baseDomain = raw.baseDomain.toLowerCase();
    cloudflare = { apiToken, email: process.env.CF_EMAIL ?? null };
  }

  let tunnel = false;
  if (raw.tunnel) {
    if (!baseDomain) {
      fatal('"tunnel" mode requires "baseDomain" to be set.\nAdd { "baseDomain": "yourdomain.com" } to your config file.');
    }
    tunnel = true;
  }

  return { port, domains, baseDomain, cloudflare, tunnel };
}

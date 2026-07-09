import * as acme from 'acme-client';
import { promises as dnsPromises } from 'dns';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import * as cf from './cloudflare';

const LE_DIRECTORY = acme.directory.letsencrypt.production;
const CERT_DIR     = path.join(os.homedir(), '.localmap', 'certs');
const META_FILE    = path.join(CERT_DIR, 'meta.json');
const ACCOUNT_KEY  = path.join(CERT_DIR, 'account-key.pem');
const CERT_FILE    = path.join(CERT_DIR, 'wildcard.pem');
const KEY_FILE     = path.join(CERT_DIR, 'wildcard-key.pem');

// Days remaining before we force-renew
const RENEW_THRESHOLD_DAYS = 30;

interface CertMeta {
  baseDomain: string;
  expiresAt: string;
}

function ensureCertDir(): void {
  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });
}

export function loadMeta(): CertMeta | null {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')) as CertMeta; } catch (_) { return null; }
}

export function isCertValid(meta: CertMeta | null, baseDomain: string): boolean {
  if (!meta || meta.baseDomain !== baseDomain) return false;
  if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) return false;
  const expiresAt = new Date(meta.expiresAt);
  const daysLeft  = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return daysLeft > RENEW_THRESHOLD_DAYS;
}

async function loadOrCreateAccountKey(): Promise<Buffer> {
  if (fs.existsSync(ACCOUNT_KEY)) {
    return fs.readFileSync(ACCOUNT_KEY);
  }
  const key = await acme.crypto.createPrivateKey();
  fs.writeFileSync(ACCOUNT_KEY, key, { mode: 0o600 });
  return key;
}

// Poll a public resolver until the ACME TXT record is visible
async function waitForTxtPropagation(baseDomain: string, expectedValue: string): Promise<void> {
  const resolver = new dnsPromises.Resolver();
  resolver.setServers(['8.8.8.8', '1.1.1.1']);
  const challengeHost = `_acme-challenge.${baseDomain}`;

  for (let i = 0; i < 24; i++) { // up to 2 minutes
    try {
      const records = await resolver.resolveTxt(challengeHost);
      if (records.flat().includes(expectedValue)) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 5000));
  }
  console.warn('  Warning: TXT record not confirmed in public DNS — proceeding anyway');
}

export async function obtainCert(
  baseDomain: string,
  cloudflareToken: string,
  email: string | null,
): Promise<{ certFile: string; keyFile: string }> {
  ensureCertDir();

  const meta = loadMeta();
  if (isCertValid(meta, baseDomain)) {
    const days = Math.floor((new Date(meta!.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    console.log(`  Using cached certificate (${days} days remaining)`);
    return { certFile: CERT_FILE, keyFile: KEY_FILE };
  }

  console.log("  Obtaining Let's Encrypt certificate via DNS-01...");

  const zoneId = await cf.getZoneId(cloudflareToken, baseDomain);
  await cf.clearAcmeTxtRecords(cloudflareToken, zoneId, baseDomain);
  const accountKey = await loadOrCreateAccountKey();

  const client = new acme.Client({ directoryUrl: LE_DIRECTORY, accountKey });

  await client.createAccount({
    termsOfServiceAgreed: true,
    ...(email ? { contact: [`mailto:${email}`] } : {}),
  });

  const [certKey, csr] = await acme.crypto.createCsr({ altNames: [`*.${baseDomain}`, baseDomain] });

  // Map keyAuth value → Cloudflare record ID so concurrent challenges each clean up their own record
  const acmeTxtRecordIds = new Map<string, string>();

  const cert = await client.auto({
    csr,
    challengePriority: ['dns-01'],
    challengeCreateFn: async (_authz, _challenge, keyAuth) => {
      console.log('  Setting DNS TXT record for ACME challenge...');
      const recordId = await cf.setAcmeTxtRecord(cloudflareToken, zoneId, baseDomain, keyAuth);
      acmeTxtRecordIds.set(keyAuth, recordId);
      console.log('  Waiting for DNS propagation...');
      await waitForTxtPropagation(baseDomain, keyAuth);
      console.log('  DNS propagation confirmed');
    },
    challengeRemoveFn: async (_authz, _challenge, keyAuth) => {
      const recordId = acmeTxtRecordIds.get(keyAuth);
      if (recordId) {
        await cf.deleteAcmeTxtRecord(cloudflareToken, zoneId, recordId);
        acmeTxtRecordIds.delete(keyAuth);
      }
    },
  });

  const certInfo  = await acme.crypto.readCertificateInfo(cert);
  const expiresAt = certInfo.notAfter;

  fs.writeFileSync(CERT_FILE, cert, { mode: 0o644 });
  fs.writeFileSync(KEY_FILE, certKey, { mode: 0o600 });
  fs.writeFileSync(
    META_FILE,
    JSON.stringify({ baseDomain, expiresAt: expiresAt.toISOString() } satisfies CertMeta, null, 2),
    { mode: 0o644 },
  );

  console.log(`  Certificate issued, valid until ${expiresAt.toISOString().split('T')[0]}`);
  return { certFile: CERT_FILE, keyFile: KEY_FILE };
}

// Background renewal — checks daily, renews when < RENEW_THRESHOLD_DAYS remain.
// Backs off exponentially on failure to avoid hammering Let's Encrypt rate limits.
export function scheduleRenewal(
  baseDomain: string,
  cloudflareToken: string,
  email: string | null,
  httpsServer: https.Server | null,
): NodeJS.Timeout {
  const CHECK_INTERVAL   = 24 * 60 * 60 * 1000;
  const MAX_BACKOFF_DAYS = 4;

  let failedAttempts = 0;
  let nextRetryAfter: number | null = null;

  const timer = setInterval(async () => {
    const meta = loadMeta();
    if (isCertValid(meta, baseDomain)) {
      failedAttempts = 0;
      nextRetryAfter = null;
      return;
    }

    if (nextRetryAfter && Date.now() < nextRetryAfter) {
      const hoursLeft = Math.ceil((nextRetryAfter - Date.now()) / (1000 * 60 * 60));
      console.log(`[dynamoip] Cert renewal backoff active — retrying in ~${hoursLeft}h`);
      return;
    }

    console.log('\n[dynamoip] Certificate renewal starting...');
    try {
      await obtainCert(baseDomain, cloudflareToken, email);
      failedAttempts = 0;
      nextRetryAfter = null;
      if (httpsServer) {
        httpsServer.setSecureContext({
          cert: fs.readFileSync(CERT_FILE),
          key:  fs.readFileSync(KEY_FILE),
        });
        console.log('[dynamoip] Certificate renewed and hot-reloaded — no restart needed');
      }
    } catch (e) {
      failedAttempts++;
      const backoffHours = Math.min(6 * Math.pow(2, failedAttempts - 1), MAX_BACKOFF_DAYS * 24);
      nextRetryAfter = Date.now() + backoffHours * 60 * 60 * 1000;
      const retryDate = new Date(nextRetryAfter).toISOString().replace('T', ' ').slice(0, 16);
      console.error(`[dynamoip] Certificate renewal failed (attempt ${failedAttempts}): ${(e as Error).message}`);
      console.error(`[dynamoip] Next retry after ${retryDate} UTC. Existing cert is still being served.`);
    }
  }, CHECK_INTERVAL);

  timer.unref();
  return timer;
}

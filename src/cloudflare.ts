import https from 'https';
import { parse as parseDomain } from 'tldts';

interface CfError { message: string }

interface CfResponse<T = unknown> {
  success: boolean;
  errors?: CfError[];
  result?: T;
}

interface CfZone {
  id: string;
  account: { id: string };
}

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

interface CfTunnel {
  id: string;
  name: string;
}

export function cfFetch<T = unknown>(
  apiToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<CfResponse<T>> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.cloudflare.com',
        path: `/client/v4${path}`,
        method,
        timeout: 10000,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as CfResponse<T>;
            if (!json.success) {
              const msg = json.errors?.map(e => e.message).join(', ') ?? 'Unknown Cloudflare error';
              reject(new Error(`Cloudflare API error: ${msg}`));
            } else {
              resolve(json);
            }
          } catch {
            const preview = data.length > 200 ? data.slice(0, 200) + '…' : data;
            reject(new Error(`Failed to parse Cloudflare response: ${preview}`));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`Cloudflare API request timed out (${method} /client/v4${path})`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Parse the registrable domain (apex) using the Public Suffix List.
// Handles multi-label TLDs correctly: "local.myteam.co.uk" -> "myteam.co.uk"
export function getApexDomain(baseDomain: string): string {
  const result = parseDomain(baseDomain);
  if (!result.domain) throw new Error(`Could not determine registrable domain for: "${baseDomain}"`);
  return result.domain;
}

export async function getZoneId(apiToken: string, baseDomain: string): Promise<string> {
  const apex = getApexDomain(baseDomain);
  const res = await cfFetch<CfZone[]>(apiToken, 'GET', `/zones?name=${apex}&status=active`);
  if (!res.result?.length) {
    throw new Error(
      `No active Cloudflare zone found for "${apex}".\n` +
      `  Make sure the domain is added to your Cloudflare account and the API token has Zone:DNS:Edit permission.`,
    );
  }
  return res.result[0].id;
}

interface DesiredRecord {
  type: 'A' | 'CNAME';
  content: string;
  proxied?: boolean; // when set, an existing record must also match this to count as "already correct"
}

// Decide what to do with the records Cloudflare returned for a hostname.
// Returns the id of a record that already matches the desired state (or null),
// plus the ids of every other record that should be deleted first — so stale
// A/AAAA/CNAME entries and duplicates never survive to conflict with the new record.
export function planDnsRecords(
  records: CfDnsRecord[],
  desired: DesiredRecord,
): { keepId: string | null; deleteIds: string[] } {
  const match = records.find(r =>
    r.type === desired.type &&
    r.content === desired.content &&
    (desired.proxied === undefined || r.proxied === desired.proxied),
  );
  const deleteIds = records.filter(r => !match || r.id !== match.id).map(r => r.id);
  return { keepId: match ? match.id : null, deleteIds };
}

// Upsert A records for all domain names pointing to lanIp
export async function upsertARecords(
  apiToken: string,
  zoneId: string,
  baseDomain: string,
  domainNames: string[],
  lanIp: string,
): Promise<void> {
  for (const name of domainNames) {
    const fqdn = `${name}.${baseDomain}`;
    // Query without type filter — a CNAME left over from Max mode would be
    // missed by ?type=A and then Cloudflare would reject the new A record
    const existing = await cfFetch<CfDnsRecord[]>(apiToken, 'GET', `/zones/${zoneId}/dns_records?name=${fqdn}`);
    const { keepId, deleteIds } = planDnsRecords(existing.result ?? [], { type: 'A', content: lanIp });

    for (const id of deleteIds) {
      await cfFetch(apiToken, 'DELETE', `/zones/${zoneId}/dns_records/${id}`);
    }

    if (keepId) {
      console.log(`  ${fqdn} -> ${lanIp}  (${deleteIds.length ? 'unchanged, cleaned up stale records' : 'unchanged'})`);
      continue;
    }

    await cfFetch(apiToken, 'POST', `/zones/${zoneId}/dns_records`, {
      type: 'A', name: fqdn, content: lanIp, ttl: 60, proxied: false,
    });
    console.log(`  ${fqdn} -> ${lanIp}  (${deleteIds.length ? 'replaced' : 'created'})`);
  }
}

// Set _acme-challenge TXT record for DNS-01 validation.
// Appends rather than replacing — Let's Encrypt may issue multiple challenges
// simultaneously and both TXT values must coexist until each is validated.
export async function setAcmeTxtRecord(
  apiToken: string,
  zoneId: string,
  baseDomain: string,
  txtValue: string,
): Promise<string> {
  const name = `_acme-challenge.${baseDomain}`;
  const res = await cfFetch<CfDnsRecord>(apiToken, 'POST', `/zones/${zoneId}/dns_records`, {
    type: 'TXT', name, content: txtValue, ttl: 60,
  });
  return res.result!.id;
}

// Delete all _acme-challenge TXT records (cleans up stale records from failed runs)
export async function clearAcmeTxtRecords(
  apiToken: string,
  zoneId: string,
  baseDomain: string,
): Promise<void> {
  const name = `_acme-challenge.${baseDomain}`;
  const existing = await cfFetch<CfDnsRecord[]>(apiToken, 'GET', `/zones/${zoneId}/dns_records?type=TXT&name=${name}`);
  for (const record of existing.result ?? []) {
    await cfFetch(apiToken, 'DELETE', `/zones/${zoneId}/dns_records/${record.id}`);
  }
}

export async function deleteAcmeTxtRecord(
  apiToken: string,
  zoneId: string,
  recordId: string,
): Promise<void> {
  try {
    await cfFetch(apiToken, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
  } catch (_) {
    // Best-effort cleanup — don't fail the startup if this errors
  }
}

// Upsert CNAME records pointing to a Cloudflare Tunnel (Max mode).
// Replaces any existing A record for the same hostname if present.
export async function upsertCnameRecords(
  apiToken: string,
  zoneId: string,
  baseDomain: string,
  domainNames: string[],
  tunnelId: string,
): Promise<void> {
  const target = `${tunnelId}.cfargotunnel.com`;
  for (const name of domainNames) {
    const fqdn = `${name}.${baseDomain}`;
    const existing = await cfFetch<CfDnsRecord[]>(apiToken, 'GET', `/zones/${zoneId}/dns_records?name=${fqdn}`);
    const { keepId, deleteIds } = planDnsRecords(existing.result ?? [], { type: 'CNAME', content: target, proxied: true });

    for (const id of deleteIds) {
      await cfFetch(apiToken, 'DELETE', `/zones/${zoneId}/dns_records/${id}`);
    }

    if (keepId) {
      console.log(`  ${fqdn} -> ${target}  (${deleteIds.length ? 'unchanged, cleaned up stale records' : 'unchanged'})`);
      continue;
    }

    await cfFetch(apiToken, 'POST', `/zones/${zoneId}/dns_records`, {
      type: 'CNAME', name: fqdn, content: target, ttl: 1, proxied: true,
    });
    console.log(`  ${fqdn} -> ${target}  (${deleteIds.length ? 'replaced' : 'created'})`);
  }
}

export async function getAccountId(apiToken: string, zoneId: string): Promise<string> {
  const res = await cfFetch<CfZone>(apiToken, 'GET', `/zones/${zoneId}`);
  const accountId = res.result?.account?.id;
  if (!accountId) throw new Error('Could not read account ID from zone details.');
  return accountId;
}

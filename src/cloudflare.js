'use strict';

const https = require('https');
const { parse: parseDomain } = require('tldts');

// Minimal Cloudflare v4 API client — only what we need
function cfFetch(apiToken, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4${path}`,
      method,
      timeout: 10000,
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.success) {
            const msg = json.errors?.map(e => e.message).join(', ') || 'Unknown Cloudflare error';
            reject(new Error(`Cloudflare API error: ${msg}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          const preview = data.length > 200 ? data.slice(0, 200) + '…' : data;
          reject(new Error(`Failed to parse Cloudflare response: ${preview}`));
        }
      });
    });
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
function getApexDomain(baseDomain) {
  const result = parseDomain(baseDomain);
  if (!result.domain) throw new Error(`Could not determine registrable domain for: "${baseDomain}"`);
  return result.domain;
}

async function getZoneId(apiToken, baseDomain) {
  const apex = getApexDomain(baseDomain);
  const res = await cfFetch(apiToken, 'GET', `/zones?name=${apex}&status=active`);
  if (!res.result?.length) {
    throw new Error(
      `No active Cloudflare zone found for "${apex}".\n` +
      `  Make sure the domain is added to your Cloudflare account and the API token has Zone:DNS:Edit permission.`
    );
  }
  return res.result[0].id;
}

// Upsert A records for all domain names pointing to lanIp
async function upsertARecords(apiToken, zoneId, baseDomain, domainNames, lanIp) {
  for (const name of domainNames) {
    const fqdn = `${name}.${baseDomain}`;

    // Query without type filter — a CNAME left over from Max mode would be
    // missed by ?type=A and then Cloudflare would reject the new A record
    const existing = await cfFetch(apiToken, 'GET', `/zones/${zoneId}/dns_records?name=${fqdn}`);
    const record = existing.result?.[0];

    if (record) {
      if (record.type === 'A' && record.content === lanIp) {
        console.log(`  ${fqdn} -> ${lanIp}  (unchanged)`);
        continue;
      }
      // Wrong type (e.g. stale CNAME from Max mode) or wrong IP — delete and recreate
      await cfFetch(apiToken, 'DELETE', `/zones/${zoneId}/dns_records/${record.id}`);
    }

    await cfFetch(apiToken, 'POST', `/zones/${zoneId}/dns_records`, {
      type: 'A',
      name: fqdn,
      content: lanIp,
      ttl: 60,
      proxied: false,
    });
    console.log(`  ${fqdn} -> ${lanIp}  (${record ? 'replaced' : 'created'})`);
  }
}

// Set _acme-challenge TXT record for DNS-01 validation.
// Appends rather than replacing — Let's Encrypt may issue multiple challenges
// simultaneously (e.g. for both *.domain.com and domain.com) and both TXT
// values must coexist until each is validated.
async function setAcmeTxtRecord(apiToken, zoneId, baseDomain, txtValue) {
  const name = `_acme-challenge.${baseDomain}`;
  const res = await cfFetch(apiToken, 'POST', `/zones/${zoneId}/dns_records`, {
    type: 'TXT',
    name,
    content: txtValue,
    ttl: 60,
  });
  return res.result.id;
}

// Delete all _acme-challenge TXT records (used to clean up stale records from failed runs)
async function clearAcmeTxtRecords(apiToken, zoneId, baseDomain) {
  const name = `_acme-challenge.${baseDomain}`;
  const existing = await cfFetch(apiToken, 'GET', `/zones/${zoneId}/dns_records?type=TXT&name=${name}`);
  for (const record of existing.result || []) {
    await cfFetch(apiToken, 'DELETE', `/zones/${zoneId}/dns_records/${record.id}`);
  }
}

async function deleteAcmeTxtRecord(apiToken, zoneId, recordId) {
  try {
    await cfFetch(apiToken, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
  } catch (_) {
    // Best-effort cleanup — don't fail the startup if this errors
  }
}

// Upsert CNAME records pointing to a Cloudflare Tunnel (Max mode).
// Replaces any existing A record for the same hostname if present.
async function upsertCnameRecords(apiToken, zoneId, baseDomain, domainNames, tunnelId) {
  const target = `${tunnelId}.cfargotunnel.com`;
  for (const name of domainNames) {
    const fqdn = `${name}.${baseDomain}`;

    // Fetch any existing record (A or CNAME) for this name
    const existing = await cfFetch(apiToken, 'GET', `/zones/${zoneId}/dns_records?name=${fqdn}`);
    const record = existing.result?.[0];

    if (record) {
      if (record.type === 'CNAME' && record.content === target && record.proxied) {
        console.log(`  ${fqdn} -> ${target}  (unchanged)`);
        continue;
      }
      // Wrong type (e.g. old A record) or wrong target — delete and recreate
      await cfFetch(apiToken, 'DELETE', `/zones/${zoneId}/dns_records/${record.id}`);
    }

    await cfFetch(apiToken, 'POST', `/zones/${zoneId}/dns_records`, {
      type: 'CNAME',
      name: fqdn,
      content: target,
      ttl: 1,       // 1 = automatic (Cloudflare managed)
      proxied: true,
    });
    console.log(`  ${fqdn} -> ${target}  (${record ? 'replaced' : 'created'})`);
  }
}

module.exports = { cfFetch, getZoneId, upsertARecords, upsertCnameRecords, setAcmeTxtRecord, deleteAcmeTxtRecord, clearAcmeTxtRecords };

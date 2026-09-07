/**
 * Windows/VPN DNS often breaks Node's c-ares resolveSrv (querySrv ETIMEOUT)
 * while HTTPS still works. Convert mongodb+srv:// to a direct mongodb:// URI
 * via Cloudflare DNS-over-HTTPS so mongoose never needs local SRV lookups.
 */
const https = require('https');

function dohQuery(name, type) {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { accept: 'application/dns-json' }, timeout: 10000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json.Answer || []);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('DoH timeout'));
    });
    req.on('error', reject);
  });
}

function parseSrvAnswers(answers) {
  return answers
    .map((a) => String(a.data || '').trim())
    .filter(Boolean)
    .map((data) => {
      const parts = data.split(/\s+/);
      return {
        priority: Number(parts[0]) || 0,
        weight: Number(parts[1]) || 0,
        port: Number(parts[2]) || 27017,
        name: String(parts[3] || '').replace(/\.$/, ''),
      };
    })
    .filter((r) => r.name);
}

function parseTxtPayload(answers) {
  const rows = answers
    .map((a) => {
      let s = a.data;
      if (Array.isArray(s)) s = s.join('');
      s = String(s ?? '').trim();
      if (s.startsWith('"') && s.endsWith('"')) {
        try {
          s = JSON.parse(s);
        } catch {
          s = s.slice(1, -1);
        }
      }
      return s;
    })
    .filter(Boolean);
  return rows[0] || '';
}

/**
 * mongodb+srv://user:pass@cluster.../db?opts
 * → mongodb://user:pass@host0:27017,host1:27017,.../db?tls=true&replicaSet=...&opts
 */
async function resolveMongoUri(uri) {
  if (!uri || !uri.startsWith('mongodb+srv://')) return uri;

  const parsed = new URL(uri.replace(/^mongodb\+srv:\/\//i, 'https://'));
  const host = parsed.hostname;
  if (!host) return uri;

  console.log('[MONGODB] Resolving Atlas SRV via DNS-over-HTTPS for', host);
  const srvAnswers = parseSrvAnswers(
    await dohQuery(`_mongodb._tcp.${host}`, 'SRV')
  );
  if (!srvAnswers.length) {
    throw new Error('DoH SRV returned no Atlas hosts');
  }

  const txtParams = parseTxtPayload(await dohQuery(host, 'TXT'));
  const auth =
    parsed.username || parsed.password
      ? `${encodeURIComponent(decodeURIComponent(parsed.username))}:${encodeURIComponent(decodeURIComponent(parsed.password))}@`
      : '';
  const dbName = (parsed.pathname || '/').replace(/^\//, '');
  const hosts = srvAnswers.map((r) => `${r.name}:${r.port}`).join(',');

  const params = new URLSearchParams(parsed.searchParams);
  if (txtParams) {
    const fromTxt = new URLSearchParams(txtParams);
    for (const [key, value] of fromTxt) {
      if (!params.has(key)) params.set(key, value);
    }
  }
  if (!params.has('tls') && !params.has('ssl')) {
    params.set('tls', 'true');
  }

  const direct = `mongodb://${auth}${hosts}/${dbName}?${params.toString()}`;
  console.log(
    '[MONGODB] DoH direct URI ready:',
    srvAnswers.length,
    'hosts, replicaSet=',
    params.get('replicaSet') || '(none)'
  );
  return direct;
}

/** Kept for compatibility; URI conversion is the reliable path. */
function installMongoDnsFallback() {
  // no-op: resolveMongoUri bypasses driver SRV lookups
}

module.exports = { installMongoDnsFallback, resolveMongoUri };

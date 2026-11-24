'use strict';

const http = require('node:http');
const https = require('node:https');
const { createHash, randomBytes } = require('node:crypto');

function exchange(url, { method, body, headers, timeout, maxBytes }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method, headers, signal: AbortSignal.timeout(timeout),
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error('A resposta da câmera ultrapassou o limite de tamanho.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

const digestAlgorithms = new Map([
  ['MD5', 'md5'], ['SHA-256', 'sha256'], ['SHA-512-256', 'sha512-256'],
]);

function digestAuthorization(challenge, url, method, body, credentials) {
  const fields = {};
  for (const [, name, quoted, bare] of challenge.matchAll(/([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g)) {
    fields[name.toLowerCase()] = quoted === undefined ? bare : quoted.replace(/\\(.)/g, '$1');
  }
  const algorithm = (fields.algorithm || 'MD5').toUpperCase();
  const hashName = digestAlgorithms.get(algorithm.replace(/-SESS$/, ''));
  const choices = (fields.qop || '').toLowerCase().split(',').map(part => part.trim());
  const qop = choices.includes('auth') ? 'auth' : choices.includes('auth-int') ? 'auth-int' : '';
  if (!hashName || !fields.nonce || fields.realm === undefined || (fields.qop && !qop)) return '';

  const hash = data => createHash(hashName).update(data).digest('hex');
  const uri = url.pathname + url.search;
  const cnonce = randomBytes(16).toString('hex');
  const nc = '00000001';
  const quote = data => '"' + String(data).replace(/["\\]/g, '\\$&') + '"';
  let ha1 = hash(credentials.username + ':' + fields.realm + ':' + credentials.password);
  if (algorithm.endsWith('-SESS')) ha1 = hash([ha1, fields.nonce, cnonce].join(':'));
  const ha2 = hash(method + ':' + uri + (qop === 'auth-int' ? ':' + hash(body ?? '') : ''));
  const response = hash((qop ? [ha1, fields.nonce, nc, cnonce, qop, ha2] : [ha1, fields.nonce, ha2]).join(':'));
  const username = fields.userhash?.toLowerCase() === 'true'
    ? hash(credentials.username + ':' + fields.realm)
    : credentials.username;
  const parts = [
    'username=' + quote(username), 'realm=' + quote(fields.realm), 'nonce=' + quote(fields.nonce),
    'uri=' + quote(uri), 'response=' + quote(response), 'algorithm=' + algorithm,
  ];
  if (fields.opaque) parts.push('opaque=' + quote(fields.opaque));
  if (qop) parts.push('qop=' + qop, 'nc=' + nc);
  if (qop || algorithm.endsWith('-SESS')) parts.push('cnonce=' + quote(cnonce));
  if (fields.userhash?.toLowerCase() === 'true') parts.push('userhash=true');
  return 'Digest ' + parts.join(', ');
}

function authorization(challenges, url, method, body, credentials) {
  const schemes = String(challenges ?? '').split(/,(?=\s*(?:Digest|Basic|Bearer|Negotiate)\s)/i);
  for (const scheme of schemes) {
    const match = scheme.match(/^\s*Digest\s+(.+)$/i);
    if (!match) continue;
    const header = digestAuthorization(match[1], url, method, body, credentials);
    if (header) return header;
  }
  if (schemes.some(scheme => /^\s*Basic\s/i.test(scheme))) {
    return 'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64');
  }
  return '';
}

async function request(url, {
  method = 'GET', body, headers = {}, credentials, timeout = 5000, maxBytes = 4 * 1024 * 1024,
} = {}) {
  const options = { method, body, headers, timeout, maxBytes };
  let response = await exchange(url, options);
  if (response.status !== 401 || !credentials?.username) return response;
  const header = authorization(response.headers['www-authenticate'], url, method, body, credentials);
  if (!header) return response;
  options.headers = { ...headers, Authorization: header };
  response = await exchange(url, options);
  if (response.status !== 401 || !/\bstale\s*=\s*"?true\b/i.test(response.headers['www-authenticate'] ?? '')) {
    return response;
  }
  const renewed = authorization(response.headers['www-authenticate'], url, method, body, credentials);
  if (!renewed) return response;
  options.headers.Authorization = renewed;
  return exchange(url, options);
}

module.exports = { request };

// netlify/functions/admin-doc-upload.js
//
// Dead-simple admin file uploader. Takes a base64 file and drops it straight into a Supabase
// Storage bucket using the SERVICE key (so it bypasses RLS and the anon-key limitations that made
// the browser uploader flaky). Admin-gated by the signed session token's email.
//
// POST { token, bucket?, path|filename, content_type?, data:<base64 or data-url> }
//   -> { ok, bucket, path, size }
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET (via _lib/session)

const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com', 'michael@thinkbeyondpractice.com', 'michael.vangelder@gmail.com'];
const MAX_BYTES = 25 * 1024 * 1024;

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Server configuration error' }) };

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };
  const email = String(session.claims.email || '').toLowerCase().trim();
  if (ADMIN_EMAILS.indexOf(email) === -1) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  const bucket = String(p.bucket || 'templates').trim().replace(/[^a-z0-9_-]/gi, '');
  let path = String(p.path || p.filename || '').trim().replace(/^\/+/, '');
  if (!path) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Missing file path/name' }) };

  const ct = String(p.content_type || 'application/octet-stream');
  let b64 = String(p.data || '');
  const comma = b64.indexOf(',');
  if (b64.slice(0, 5) === 'data:' && comma !== -1) b64 = b64.slice(comma + 1);
  let bytes;
  try { bytes = Buffer.from(b64, 'base64'); } catch (e) { bytes = null; }
  if (!bytes || !bytes.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Could not read the file' }) };
  if (bytes.length > MAX_BYTES) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'File is too large (max 25 MB)' }) };

  try {
    const up = await fetch(URL + '/storage/v1/object/' + bucket + '/' + encodeURI(path), {
      method: 'POST',
      headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': ct, 'x-upsert': 'true' },
      body: bytes
    });
    if (!up.ok) {
      const t = await up.text();
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'Storage upload failed: ' + t.slice(0, 300) }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, bucket: bucket, path: path, size: bytes.length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) };
  }
};

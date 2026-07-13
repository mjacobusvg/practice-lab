// netlify/functions/upload-post-file.js
// A member uploads a document (PDF / Office / text) to attach to a post they are
// composing. Identity is the signed session token; the file lands in the public
// 'post-files' bucket under the member's account id. Returns { url, name, type,
// size } which the composer tracks and sends back as `attachments`. Writes with
// the service role key.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
// Body: { token, data:<base64 or data-url>, content_type, filename }

const { verifyToken } = require('./_lib/session');

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const BUCKET = 'post-files';

// Allowed document types -> extension. Anything else is rejected.
const TYPE_EXT = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv'
};

// A display name that can't break out of HTML later (rendering escapes too, but
// keep it clean): strip control chars/slashes, cap length.
function cleanName(name, ext) {
  var n = String(name || '').replace(/[\\/]+/g, ' ').replace(/[\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!n) n = 'attachment.' + ext;
  return n;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };
  if (session.claims.scope !== 'member') return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Members only' }) };
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  const ct = String(p.content_type || '').toLowerCase().split(';')[0].trim();
  const ext = TYPE_EXT[ct];
  if (!ext) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unsupported file type. Use PDF, Word, Excel, PowerPoint, TXT, or CSV.' }) };

  let b64 = String(p.data || '');
  const comma = b64.indexOf(',');
  if (b64.slice(0, 5) === 'data:' && comma !== -1) b64 = b64.slice(comma + 1);
  let bytes;
  try { bytes = Buffer.from(b64, 'base64'); } catch (e) { bytes = null; }
  if (!bytes || !bytes.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Could not read the file.' }) };
  if (bytes.length > MAX_BYTES) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'File is too large (max 25 MB).' }) };

  try {
    const sbHeaders = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    const accts = await fetch(SUPABASE_URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1', { headers: sbHeaders });
    const acctRows = await accts.json();
    if (!Array.isArray(acctRows) || !acctRows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found.' }) };
    const accountId = acctRows[0].id;

    const rand = Math.random().toString(36).slice(2, 10);
    const objectPath = accountId + '/' + Date.now() + '-' + rand + '.' + ext;
    const upRes = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + objectPath, {
      method: 'POST',
      headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': ct, 'x-upsert': 'true' },
      body: bytes
    });
    if (!upRes.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'Upload failed: ' + (await upRes.text()).slice(0, 150) }) };
    }
    const publicUrl = SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + objectPath;
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, url: publicUrl, name: cleanName(p.filename, ext), type: ext, size: bytes.length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

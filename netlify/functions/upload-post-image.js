// netlify/functions/upload-post-image.js
// A member uploads an image to attach to a post they are composing. Identity is
// the signed session token; the file lands in the public 'post-images' bucket
// under the member's account id. Returns the public URL, which the composer
// tracks and sends back as image_urls when the post is created. Writes with the
// service role key (storage RLS stays locked for anon clients).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
// Body: { token, data:<base64 or data-url>, content_type:'image/png' }

const { verifyToken } = require('./_lib/session');

const MAX_BYTES = 6 * 1024 * 1024; // 6 MB
const BUCKET = 'post-images';

function extFromContentType(ct) {
  const c = (ct || '').toLowerCase();
  if (c.indexOf('png') !== -1) return 'png';
  if (c.indexOf('jpeg') !== -1 || c.indexOf('jpg') !== -1) return 'jpg';
  if (c.indexOf('webp') !== -1) return 'webp';
  if (c.indexOf('gif') !== -1) return 'gif';
  return null;
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

  const ct = String(p.content_type || '').toLowerCase();
  const ext = extFromContentType(ct);
  if (!ext) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Use a PNG, JPG, WEBP, or GIF image.' }) };

  let b64 = String(p.data || '');
  const comma = b64.indexOf(',');
  if (b64.slice(0, 5) === 'data:' && comma !== -1) b64 = b64.slice(comma + 1);
  let bytes;
  try { bytes = Buffer.from(b64, 'base64'); } catch (e) { bytes = null; }
  if (!bytes || !bytes.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Could not read the image.' }) };
  if (bytes.length > MAX_BYTES) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Image is too large (max 6 MB).' }) };

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
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, url: publicUrl }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

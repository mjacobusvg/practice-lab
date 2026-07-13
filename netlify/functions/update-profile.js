// netlify/functions/update-profile.js
// A member edits their OWN profile: display fields and avatar. Identity comes
// from the signed session token (never a client email), and the account is
// matched by that email, so a member can only ever change their own row.
// Writes with the Supabase service role key (accounts/storage RLS stays locked
// for anon clients).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
// Actions:
//   { token, action:'save', name?, credentials?, headline?, location?,
//     practice_type?, directory_visible? }
//   { token, action:'avatar', data:<base64>, content_type:'image/png' }

const { verifyToken } = require('./_lib/session');

const PRACTICE_TYPES = ['solo', 'group_owner', 'group_member', 'employed', 'locums', 'other'];
const LIMITS = { name: 100, credentials: 100, headline: 160, location: 100, bio: 1500 };

// A link field must be an http(s) URL or empty (blocks javascript: and other
// schemes, since these render as href attributes).
function cleanUrl(v) {
  var s = String(v == null ? '' : v).trim().slice(0, 300);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(s)) return null;
  return s;
}
const MAX_AVATAR_BYTES = 3 * 1024 * 1024; // 3 MB

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

  const sbHeaders = {
    'apikey': KEY,
    'Authorization': 'Bearer ' + KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
  const sb = async (path, method, body) => {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers: sbHeaders, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 200));
    return text ? JSON.parse(text) : null;
  };

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
  const emailFilter = 'email=eq.' + encodeURIComponent(email);

  try {
    const accts = await sb('accounts?' + emailFilter + '&select=id&limit=1', 'GET');
    if (!accts || !accts.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found. Refresh and sign in again.' }) };
    }
    const accountId = accts[0].id;

    if (p.action === 'save') {
      const patch = {};
      // Text fields: trim + length-cap. Empty string clears the field (-> null).
      ['name', 'credentials', 'headline', 'location', 'bio'].forEach(function (f) {
        if (Object.prototype.hasOwnProperty.call(p, f)) {
          const v = String(p[f] == null ? '' : p[f]).trim().slice(0, LIMITS[f]);
          patch[f] = v.length ? v : null;
        }
      });
      // Link fields: validated to http(s) or null.
      ['website', 'linkedin_url'].forEach(function (f) {
        if (Object.prototype.hasOwnProperty.call(p, f)) patch[f] = cleanUrl(p[f]);
      });
      if (Object.prototype.hasOwnProperty.call(p, 'practice_type')) {
        const pt = String(p.practice_type || '').trim();
        patch.practice_type = PRACTICE_TYPES.indexOf(pt) !== -1 ? pt : null;
      }
      if (Object.prototype.hasOwnProperty.call(p, 'directory_visible')) {
        patch.directory_visible = !!p.directory_visible;
      }
      // Never allow name to be blanked to null (it anchors the identity everywhere).
      if (patch.name === null) delete patch.name;

      if (!Object.keys(patch).length) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Nothing to update' }) };
      }
      patch.updated_at = new Date().toISOString();

      const updated = await sb('accounts?' + emailFilter + '&select=id,name,credentials,headline,location,practice_type,directory_visible,avatar_url,tier,bio,website,linkedin_url', 'PATCH', patch);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, account: (updated && updated[0]) || null }) };
    }

    if (p.action === 'avatar') {
      const ct = String(p.content_type || '').toLowerCase();
      const ext = extFromContentType(ct);
      if (!ext) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Use a PNG, JPG, WEBP, or GIF image.' }) };

      // Accept raw base64 or a data: URL.
      let b64 = String(p.data || '');
      const comma = b64.indexOf(',');
      if (b64.slice(0, 5) === 'data:' && comma !== -1) b64 = b64.slice(comma + 1);
      let bytes;
      try { bytes = Buffer.from(b64, 'base64'); } catch (e) { bytes = null; }
      if (!bytes || !bytes.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Could not read the image.' }) };
      if (bytes.length > MAX_AVATAR_BYTES) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Image is too large (max 3 MB).' }) };

      const objectPath = accountId + '.' + ext;
      const upRes = await fetch(SUPABASE_URL + '/storage/v1/object/avatars/' + objectPath, {
        method: 'POST',
        headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': ct, 'x-upsert': 'true' },
        body: bytes
      });
      if (!upRes.ok) {
        return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'Upload failed: ' + (await upRes.text()).slice(0, 150) }) };
      }
      // Cache-bust so the new image replaces the old one immediately in browsers.
      const publicUrl = SUPABASE_URL + '/storage/v1/object/public/avatars/' + objectPath + '?v=' + Date.now();
      await sb('accounts?' + emailFilter, 'PATCH', { avatar_url: publicUrl, updated_at: new Date().toISOString() });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, avatar_url: publicUrl }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

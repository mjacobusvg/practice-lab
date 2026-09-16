// netlify/functions/template-intake.js
// Admin-only. Actions: create (sign an upload + open an intake row), list (queue +
// manifest gaps), publish (intake -> library), dismiss.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const crypto = require('crypto');
const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];

// Upload constraints for the 'create' action. The bucket is NOT caller-selectable
// and the object path is generated here, never taken from the client, so there is
// no path-injection or bucket-hopping surface.
const UPLOAD_BUCKET = 'templates';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXT = ['pdf', 'docx', 'doc', 'rtf', 'zip', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'csv'];

// One path segment, alphanumerics plus . _ - only. '/' is stripped, so the result
// can never traverse, and the generated prefix means it can never begin with '..'.
function safeObjectPath(filename) {
  const base = String(filename || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'upload';
  return Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '_' + base;
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

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Invalid or expired session.' }) };
  const email = String(session.claims.email || '').toLowerCase().trim();
  if (ADMIN_EMAILS.indexOf(email) === -1) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  const h = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  try {
    // Signs a one-shot upload into the private 'templates' bucket and opens the
    // matching intake row, so template-upload.html never needs the anon key.
    // Replaces the old browser-side SB.storage.upload() + SB.from('template_intake')
    // .insert(), which only worked because the bucket and table carried anon
    // INSERT/SELECT/UPDATE policies — i.e. anyone on the internet could upload
    // arbitrary files and read the whole template library. Security audit finding H2.
    if (p.action === 'create') {
      const filename = String(p.filename || '').trim();
      const fileSize = Number(p.file_size);
      if (!filename) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'filename required' }) };
      if (!Number.isFinite(fileSize) || fileSize <= 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'file_size required' }) };
      }
      if (fileSize > MAX_UPLOAD_BYTES) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'File is too large (max 25 MB).' }) };
      }
      const ext = filename.indexOf('.') === -1 ? '' : filename.split('.').pop().toLowerCase();
      if (ALLOWED_EXT.indexOf(ext) === -1) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unsupported file type: .' + ext }) };
      }

      const storagePath = safeObjectPath(filename);

      // Signed upload URL — the browser PUTs the bytes straight to Storage, so this
      // is not bounded by Netlify's ~6MB function body limit.
      const signRes = await fetch(
        URL + '/storage/v1/object/upload/sign/' + UPLOAD_BUCKET + '/' + encodeURIComponent(storagePath),
        { method: 'POST', headers: h, body: JSON.stringify({}) });
      const sd = await signRes.json().catch(function () { return null; });
      if (!signRes.ok || !sd || !sd.url) {
        return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'Could not create upload URL.' }) };
      }

      const ins = await fetch(URL + '/rest/v1/template_intake', {
        method: 'POST', headers: Object.assign({}, h, { 'Prefer': 'return=representation' }),
        body: JSON.stringify({
          original_filename: filename.slice(0, 300),
          storage_path: storagePath,
          file_size: fileSize,
          status: 'uploaded'
        })
      });
      if (!ins.ok) { const t = await ins.text(); throw new Error('Intake insert ' + ins.status + ': ' + t.slice(0, 150)); }
      const insRows = await ins.json();
      if (!insRows || !insRows.length) throw new Error('Intake insert returned no row');

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          intake_id: insRows[0].id,
          storage_path: storagePath,
          upload_url: URL + '/storage/v1' + sd.url
        })
      };
    }

    if (p.action === 'list') {
      const qRes = await fetch(URL + '/rest/v1/template_intake?status=in.(uploaded,analyzed)&select=*&order=created_at.asc', { headers: h });
      const queue = await qRes.json();
      const mRes = await fetch(URL + '/rest/v1/template_manifest?select=post_title,category,expected_files,has_file&order=category.asc', { headers: h });
      const manifest = await mRes.json();
      const gaps = (manifest || []).filter(m => !m.has_file);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, queue: queue || [], manifest: manifest || [], gaps: gaps }) };
    }

    if (p.action === 'publish') {
      const id = String(p.id || '').trim();
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'id required' }) };
      // Read the intake row
      const iRes = await fetch(URL + '/rest/v1/template_intake?id=eq.' + encodeURIComponent(id) + '&select=*', { headers: h });
      const rows = await iRes.json();
      if (!rows || !rows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Intake row not found' }) };
      const r = rows[0];
      // Use edited values if the client passed them, else AI proposals
      const title = String(p.title || r.ai_title || r.original_filename).trim();
      const description = String(p.description != null ? p.description : (r.ai_description || '')).trim() || null;
      const category = String(p.category || r.ai_category || 'general');
      const min_tier = String(p.tier || r.ai_tier || 'full');
      const matched = String(p.matched_post != null ? p.matched_post : (r.matched_post_title || '')).trim();

      // Insert into the live library
      const ins = await fetch(URL + '/rest/v1/template_library', {
        method: 'POST', headers: Object.assign({}, h, { 'Prefer': 'return=representation' }),
        body: JSON.stringify({ title, description, category, min_tier, storage_path: r.storage_path })
      });
      if (!ins.ok) { const t = await ins.text(); throw new Error('Library insert ' + ins.status + ': ' + t.slice(0,150)); }

      // Mark intake published
      await fetch(URL + '/rest/v1/template_intake?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH', headers: h, body: JSON.stringify({ status: 'published' })
      });
      // Flip manifest has_file if matched
      if (matched) {
        await fetch(URL + '/rest/v1/template_manifest?post_title=eq.' + encodeURIComponent(matched), {
          method: 'PATCH', headers: h, body: JSON.stringify({ has_file: true })
        });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (p.action === 'dismiss') {
      const id = String(p.id || '').trim();
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'id required' }) };
      await fetch(URL + '/rest/v1/template_intake?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH', headers: h, body: JSON.stringify({ status: 'dismissed' })
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

// netlify/functions/template-intake.js
// Admin-only. Actions: list (queue + manifest gaps), publish (intake -> library), dismiss.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const email = String(p.email || '').toLowerCase().trim();
  if (ADMIN_EMAILS.indexOf(email) === -1) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  const h = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  try {
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

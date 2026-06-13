// netlify/functions/template-admin.js
// Admin-only: add or remove templates in template_library.
// Files live in the private 'templates' Supabase Storage bucket (storage_path).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];
const VALID_TIERS = ['free', 'forum', 'full'];
const VALID_CATS = ['documentation', 'billing', 'letters', 'policies', 'clinical', 'operations', 'general'];

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

  const sbHeaders = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  try {
    if (p.action === 'add') {
      const title = String(p.title || '').trim();
      if (!title) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Title required' }) };
      const row = {
        title: title,
        description: String(p.description || '').trim() || null,
        category: VALID_CATS.indexOf(p.category) !== -1 ? p.category : 'general',
        min_tier: VALID_TIERS.indexOf(p.min_tier) !== -1 ? p.min_tier : 'full',
        file_url: String(p.file_url || '').trim() || null,
        storage_path: String(p.storage_path || '').trim() || null
      };
      const res = await fetch(URL + '/rest/v1/template_library', {
        method: 'POST', headers: Object.assign({}, sbHeaders, { 'Prefer': 'return=representation' }), body: JSON.stringify(row)
      });
      const body = await res.text();
      if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + body.slice(0, 200));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (p.action === 'remove') {
      const id = String(p.id || '').trim();
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'id required' }) };
      const look = await fetch(URL + '/rest/v1/template_library?id=eq.' + encodeURIComponent(id) + '&select=storage_path', { headers: sbHeaders });
      const rows = await look.json();
      const sp = (rows && rows[0]) ? rows[0].storage_path : null;
      const del = await fetch(URL + '/rest/v1/template_library?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ visible: false })
      });
      if (!del.ok) throw new Error('Supabase ' + del.status);
      if (sp) {
        await fetch(URL + '/storage/v1/object/templates/' + sp, { method: 'DELETE', headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY } });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

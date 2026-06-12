// netlify/functions/template-admin.js
// Admin-only: add a template to template_library.
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

  if (p.action !== 'add') return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };

  const title = String(p.title || '').trim();
  if (!title) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Title required' }) };
  const category = VALID_CATS.indexOf(p.category) !== -1 ? p.category : 'general';
  const min_tier = VALID_TIERS.indexOf(p.min_tier) !== -1 ? p.min_tier : 'full';

  const row = {
    title: title,
    description: String(p.description || '').trim() || null,
    category: category,
    min_tier: min_tier,
    file_url: String(p.file_url || '').trim() || null
  };

  try {
    const res = await fetch(URL + '/rest/v1/template_library', {
      method: 'POST',
      headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(row)
    });
    const body = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + body.slice(0, 200));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

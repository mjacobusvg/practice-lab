// netlify/functions/admin-list-templates.js
// ADMIN-ONLY: returns every template_library row, including visible=false ones, so an
// admin can preview unreleased cards (e.g. a dark-launched set) before they are made
// member-visible. The browser anon key can only read visible=true rows (RLS policy
// template_library_public_read), so this service-role path is the only way to see hidden
// rows, and it is gated to admin emails. Non-admins get 403; members never reach hidden rows.
//
// Body: { token } (or Bearer) -> { ok, rows: [...] }
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com', 'michael@thinkbeyondpractice.com', 'michael.vangelder@gmail.com'];
const SELECT = 'id,title,description,category,min_tier,is_paid,price_cents,member_price_cents,grant_membership_days,preview,source_post_id,file_url,storage_path,bundle_id,visible,version,last_reviewed,sort_order,created_at';

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
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in' }) };
  const email = String(session.claims.email || '').toLowerCase().trim();
  if (ADMIN_EMAILS.indexOf(email) === -1) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };

  try {
    const res = await fetch(URL + '/rest/v1/template_library?select=' + encodeURIComponent(SELECT) + '&order=sort_order.asc&order=created_at.desc',
      { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    const rows = res.ok ? await res.json() : [];
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rows: Array.isArray(rows) ? rows : [] }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

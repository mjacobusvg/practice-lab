// netlify/functions/roadmap-vote.js
// Casts roadmap votes (one per member per item, enforced in the database)
// and lets the admin add roadmap items. Same env vars as the other functions:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

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

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };

  const sbHeaders = {
    'apikey': KEY,
    'Authorization': 'Bearer ' + KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  try {
    if (p.action === 'vote') {
      const itemId = String(p.item_id || '').trim();
      const email = String(p.email || '').trim().toLowerCase();
      if (!itemId || !email || email.indexOf('@') === -1) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Sign in to vote' }) };
      }
      const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/cast_roadmap_vote', {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({ p_item: itemId, p_email: email })
      });
      const body = await res.text();
      if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + body.slice(0, 200));
      const count = parseInt(body, 10);
      if (count === -1) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, already: true }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: count }) };
    }

    if (p.action === 'add') {
      const email = String(p.email || '').toLowerCase().trim();
      if (ADMIN_EMAILS.indexOf(email) === -1) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
      const title = String(p.title || '').trim();
      const description = String(p.description || '').trim();
      const itemType = ['tool','topic','post','ce','feature'].indexOf(p.item_type) !== -1 ? p.item_type : 'tool';
      if (!title) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Title required' }) };
      const res = await fetch(SUPABASE_URL + '/rest/v1/roadmap_items', {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({ title: title, description: description || null, item_type: itemType })
      });
      const body = await res.text();
      if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + body.slice(0, 200));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

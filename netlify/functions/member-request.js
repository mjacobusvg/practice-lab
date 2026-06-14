// netlify/functions/member-request.js
// Accepts Request a Tool / Request a Topic / Request a CE submissions
// and inserts them into member_requests with the service role key.
//
// Required env vars (same as create-post.js):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// Notification wiring: to get an email per request, copy the SES send block
// from access-request.js into the marked spot below. Insert works without it;
// requests are always visible in the member_requests table.

const VALID_TYPES = ['tool', 'topic', 'ce'];

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
  if (!SUPABASE_URL || !KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const type = String(p.type || '').toLowerCase().trim();
  const text = String(p.text || '').trim();
  const name = String(p.name || '').trim().slice(0, 120);
  const email = String(p.email || '').trim().toLowerCase().slice(0, 200);

  if (VALID_TYPES.indexOf(type) === -1) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid request type' }) };
  if (text.length < 10) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Tell us a bit more (at least 10 characters).' }) };
  if (text.length > 4000) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Request too long (4000 character max).' }) };

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/member_requests', {
      method: 'POST',
      headers: {
        'apikey': KEY,
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        request_type: type,
        request_text: text,
        requester_name: name || null,
        requester_email: email || null
      })
    });
    const body = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + body.slice(0, 200));

    // ── Optional notification: copy the SES send block from access-request.js
    // here, e.g. subject `[TBP] New ${type} request from ${name || 'a member'}`.

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

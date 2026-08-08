// netlify/functions/tool-feedback.js
//
// In-tool feedback capture (Practice Lab Simulator / Denial Drill), Circle-free.
// This REPLACES circle-comment.js, which posted feedback to Circle posts under a
// Circle member JWT. Feedback now lands in the Supabase tool_feedback table, which
// the team reads directly. Identity comes from the SIGNED session token — never a
// client-supplied email or a Circle JWT.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET (via _lib/session)
// Body: { token, source, category, context, body, is_public? }

const { verifyToken } = require('./_lib/session');

const MAX_BODY_CHARS = 4000;
const MAX_CTX_CHARS = 200;

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ success: false, message: 'Method not allowed' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ success: false, message: 'Server configuration error' }) };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Invalid request' }) }; }

  // Identity from the SIGNED session token, never a client-supplied email.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: 'Session expired. Please refresh and sign in again.' }) };
  if (session.claims.scope !== 'member') return { statusCode: 403, headers, body: JSON.stringify({ success: false, message: 'Members only' }) };
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: 'Session expired. Please refresh and sign in again.' }) };

  const body = String(p.body || '').trim().slice(0, MAX_BODY_CHARS);
  if (!body) return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Please write something first.' }) };

  const row = {
    member_email: email,
    source: String(p.source || '').trim().slice(0, 40) || null,
    category: String(p.category || '').trim().slice(0, 120) || null,
    context: String(p.context || '').trim().slice(0, MAX_CTX_CHARS) || null,
    is_public: p.is_public === true,
    body: body
  };

  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/tool_feedback', {
      method: 'POST',
      headers: {
        'apikey': KEY,
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 200));
    }
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'Feedback sent' }) };
  } catch (err) {
    console.error('tool-feedback error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ success: false, message: 'Could not send feedback. Please try again.' }) };
  }
};

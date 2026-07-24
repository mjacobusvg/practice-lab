// netlify/functions/hpi-house-templates.js
//
// Serves the "house default" HPI templates that a brand-new clinician's AI Scribe
// falls back to when they have not built their own template yet. The source of
// truth is the founder's own Vault (a real, proven psychiatric template), read
// LIVE, so improving that Vault improves every new user's starting default with no
// snapshot to maintain.
//
// Returns ONLY template STRUCTURE (the reusable HPI scaffold), never patient data.
// Token-gated to a valid signed session so it is not open to anonymous scraping.
//
// POST { token? }  ->  { new_eval, follow_up }
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET (via _lib/session)

const { verifyToken } = require('./_lib/session');

// The account whose Vault templates are the community-wide default. Michael's.
const HOUSE_EMAIL = 'michael@thinkbeyondpsych.com';

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const v = verifyToken(token);
  if (!v.valid) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };

  try {
    const r = await fetch(
      URL + '/rest/v1/user_tool_data?email=eq.' + encodeURIComponent(HOUSE_EMAIL) + '&tool_id=eq.vault_profile&select=data',
      { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } }
    );
    const rows = r.ok ? await r.json() : [];
    const data = (rows[0] && rows[0].data) || {};
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        new_eval: data.hpiTemplateEval || '',
        follow_up: data.hpiTemplateFollowup || ''
      })
    };
  } catch (e) {
    // Never hard-fail: an empty default just means the Scribe falls back to its
    // built-in conventional structure, exactly as it did before this endpoint existed.
    return { statusCode: 200, headers, body: JSON.stringify({ new_eval: '', follow_up: '' }) };
  }
};

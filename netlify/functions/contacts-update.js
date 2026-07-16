// netlify/functions/contacts-update.js
// Admin-only edits to roster rows (public.contacts): set a contact's tier or
// subscription, one at a time or in bulk. This is how the admin promotes the
// Circle "members" who came in at free tier up to forum/full, or corrects a tier.
//
// Body (single):  { token, email, tier?, subscribed? }
// Body (bulk):    { token, emails:[...], tier?, subscribed? }
// -> { ok, updated }
//
// Changing a contact's tier here also updates any linked account row (so the
// change takes effect on the platform immediately, not just on next sign-in).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];
const VALID_TIERS = { free: 1, forum: 1, full: 1 };

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
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid || ADMIN_EMAILS.indexOf(String(session.claims.email || '').toLowerCase()) === -1) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };
  }

  let emails = [];
  if (Array.isArray(p.emails)) emails = p.emails;
  else if (p.email) emails = [p.email];
  emails = emails.map(function (e) { return String(e || '').toLowerCase().trim(); }).filter(function (e) { return e.indexOf('@') !== -1; });
  if (!emails.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'No email(s)' }) };
  if (emails.length > 2000) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Too many (max 2000)' }) };

  const patch = { updated_at: new Date().toISOString() };
  let tier = null;
  if (p.tier != null) {
    tier = String(p.tier).toLowerCase();
    if (!VALID_TIERS[tier]) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad tier' }) };
    patch.tier = tier;
  }
  if (typeof p.subscribed === 'boolean') {
    patch.subscribed = p.subscribed;
    patch.unsubscribed_at = p.subscribed ? null : new Date().toISOString();
  }
  if (Object.keys(patch).length <= 1) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Nothing to update' }) };

  const inList = '(' + emails.map(function (e) { return '"' + e.replace(/"/g, '') + '"'; }).join(',') + ')';

  try {
    const res = await fetch(URL + '/rest/v1/contacts?email=in.' + encodeURIComponent(inList), {
      method: 'PATCH', headers: Object.assign({ Prefer: 'return=minimal' }, auth), body: JSON.stringify(patch)
    });
    if (!res.ok) { const t = await res.text(); throw new Error('contacts ' + res.status + ': ' + t.slice(0, 150)); }

    // Mirror tier onto linked account rows so access changes immediately.
    if (tier) {
      try {
        await fetch(URL + '/rest/v1/accounts?email=in.' + encodeURIComponent(inList), {
          method: 'PATCH', headers: Object.assign({ Prefer: 'return=minimal' }, auth),
          body: JSON.stringify({ tier: tier, updated_at: new Date().toISOString() })
        });
      } catch (e) { /* account mirror best-effort */ }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, updated: emails.length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

// netlify/functions/contacts-import.js
// Admin-only bulk upsert into the community roster (public.contacts). This is how
// the FULL Circle Audience export (or any CSV) flows into our own store so the
// list no longer lives in Circle.
//
// The admin UI parses the CSV in the browser and POSTs normalized rows, so this
// function never has to guess at arbitrary Circle column headers.
//
// Body: {
//   token,
//   rows: [{ email, name?, first_name?, last_name?, tier?, headline?,
//            circle_id?, circle_status?, tags?, subscribed? }],
//   default_tier?  // 'free'|'forum'|'full' applied to rows with no explicit tier
//   dry_run?       // true => validate + report, write nothing
// }
// -> { ok, received, valid, invalid, with_tier, without_tier, dry_run }
//
// Tier safety: a row's tier is written ONLY when the row explicitly carries a
// valid tier (or default_tier is set). Rows without a tier are upserted WITHOUT
// the tier column, so an existing forum/full member is never silently demoted to
// free by re-importing a tier-less CSV (PostgREST merge-duplicates only updates
// the columns present in the payload).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];
const VALID_TIERS = { free: 1, forum: 1, full: 1 };

function normEmail(v) {
  return String(v == null ? '' : v).toLowerCase().trim();
}
function isEmail(e) {
  return e && e.indexOf('@') > 0 && e.indexOf('.') !== -1 && !/\s/.test(e);
}

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
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid || ADMIN_EMAILS.indexOf(String(session.claims.email || '').toLowerCase()) === -1) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };
  }

  const rows = Array.isArray(p.rows) ? p.rows : [];
  if (!rows.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'No rows' }) };
  if (rows.length > 5000) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Too many rows (max 5000 per call)' }) };

  const defaultTier = VALID_TIERS[String(p.default_tier || '').toLowerCase()] ? String(p.default_tier).toLowerCase() : null;

  const withTier = [], withoutTier = [];
  let invalid = 0;
  const seen = {};
  rows.forEach(function (r) {
    const email = normEmail(r.email);
    if (!isEmail(email) || seen[email]) { if (!isEmail(email)) invalid++; return; }
    seen[email] = true;
    const base = { email: email, updated_at: new Date().toISOString() };
    if (r.name != null && String(r.name).trim()) base.name = String(r.name).trim();
    if (r.first_name != null && String(r.first_name).trim()) base.first_name = String(r.first_name).trim();
    if (r.last_name != null && String(r.last_name).trim()) base.last_name = String(r.last_name).trim();
    if (r.headline != null && String(r.headline).trim()) base.headline = String(r.headline).trim();
    if (r.circle_id != null && String(r.circle_id).trim()) { const n = parseInt(r.circle_id, 10); if (!isNaN(n)) base.circle_id = n; }
    if (r.circle_status != null && String(r.circle_status).trim()) base.circle_status = String(r.circle_status).trim();
    if (Array.isArray(r.tags)) base.tags = r.tags;
    if (typeof r.subscribed === 'boolean') base.subscribed = r.subscribed;

    const rowTier = VALID_TIERS[String(r.tier || '').toLowerCase()] ? String(r.tier).toLowerCase() : null;
    const tier = rowTier || defaultTier;
    if (tier) { base.tier = tier; withTier.push(base); }
    else withoutTier.push(base);
  });

  const valid = withTier.length + withoutTier.length;
  if (p.dry_run) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, dry_run: true, received: rows.length, valid: valid, invalid: invalid, with_tier: withTier.length, without_tier: withoutTier.length }) };
  }

  const upsert = async (batch) => {
    if (!batch.length) return;
    for (let i = 0; i < batch.length; i += 500) {
      const chunk = batch.slice(i, i + 500);
      const res = await fetch(URL + '/rest/v1/contacts?on_conflict=email', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, auth),
        body: JSON.stringify(chunk)
      });
      if (!res.ok) { const t = await res.text(); throw new Error('upsert ' + res.status + ': ' + t.slice(0, 200)); }
    }
  };

  try {
    await upsert(withTier);
    await upsert(withoutTier);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, dry_run: false, received: rows.length, valid: valid, invalid: invalid, with_tier: withTier.length, without_tier: withoutTier.length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

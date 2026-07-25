// netlify/functions/revert-expired-comps.js
//
// Scheduled: daily. Reverts any limited-time comp whose tier_override has expired.
// A "comp" is a tier_override with an expiry date in the past. The heavy lifting is
// a single atomic SQL function (revert_expired_comps) that only touches accounts
// with NO active subscription, so a paying member who carries an override is never
// downgraded. Reverted accounts drop to free, the override is cleared, and the
// template block is lifted.
//
// This deliberately does NOT touch the live sign-in path — it just cleans state on
// a schedule, so comps self-expire without anyone remembering a revert date.
//
// Trigger: the Netlify scheduler (body carries next_run) or a manual POST with
// { secret: BACKFILL_SECRET }.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKFILL_SECRET

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, SECRET = process.env.BACKFILL_SECRET;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env' }) };

  // Authorize: Netlify scheduler (body has next_run) or the manual secret.
  let allowed = false;
  try {
    const b = JSON.parse(event.body || '{}');
    if (b && b.next_run) allowed = true;
    if (SECRET && b && b.secret === SECRET) allowed = true;
  } catch (e) { /* empty/invalid body */ }
  if (!allowed) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };

  try {
    const res = await fetch(URL + '/rest/v1/rpc/revert_expired_comps', {
      method: 'POST',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: '{}'
    });
    if (!res.ok) {
      const t = await res.text();
      return { statusCode: 502, headers, body: JSON.stringify({ ok: false, error: 'RPC failed: ' + t.slice(0, 300) }) };
    }
    const rows = await res.json();
    const emails = Array.isArray(rows) ? rows.map(function (r) { return r.email; }) : [];
    if (emails.length) console.log('revert-expired-comps reverted:', emails.join(', '));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reverted: emails.length, emails: emails }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) };
  }
};

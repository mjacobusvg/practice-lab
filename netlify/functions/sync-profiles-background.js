// netlify/functions/sync-profiles-background.js
//
// One-time (re-runnable) backfill of member profile fields from Circle into
// accounts. Circle stores each member's headline, bio, location, website, and
// LinkedIn (flattened_profile_fields); the platform imported names/avatars but
// not these, so profiles look empty. This pulls them in while Circle is up.
//
// Fills ONLY fields that are currently empty on the account, so it never
// overwrites a value a member has since edited on the platform. Idempotent and
// re-runnable. Secret-gated. Logs progress to migration_log.
//
// Trigger: POST { secret } to /.netlify/functions/sync-profiles-background
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIRCLE_API_TOKEN, BACKFILL_SECRET

const TIME_BUDGET_MS = 800 * 1000;
const CIRCLE_FIELDS = ['headline', 'bio', 'location', 'website', 'linkedin_url'];

exports.handler = async function (event) {
  const started = Date.now();
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }
  if (!process.env.BACKFILL_SECRET || body.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const CIRCLE_TOKEN = process.env.CIRCLE_API_TOKEN;
  if (!SUPABASE_URL || !SERVICE_KEY || !CIRCLE_TOKEN) {
    return { statusCode: 500, body: 'Missing env vars' };
  }

  const sbHeaders = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY };

  async function logRow(tag, detail) {
    try {
      await fetch(SUPABASE_URL + '/rest/v1/migration_log', {
        method: 'POST',
        headers: Object.assign({}, sbHeaders, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ tag: tag, detail: detail })
      });
    } catch (e) {}
  }

  // Accounts linked to a Circle member and missing at least one profile field.
  let accounts;
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/accounts?select=id,circle_member_id,headline,bio,location,website,linkedin_url' +
      '&circle_member_id=not.is.null&limit=2000',
      { headers: sbHeaders }
    );
    if (!res.ok) throw new Error('accounts ' + res.status + ': ' + (await res.text()).slice(0, 200));
    accounts = await res.json();
  } catch (e) {
    await logRow('profile-sync-error', { stage: 'load-accounts', message: e.message });
    return { statusCode: 500, body: 'Load failed' };
  }

  await logRow('profile-sync-start', { candidates: accounts.length });
  const stats = { total: accounts.length, updated: 0, unchanged: 0, errors: 0 };
  const failures = [];

  for (let i = 0; i < accounts.length; i++) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      await logRow('profile-sync-stop', { processed: i, remaining: accounts.length - i });
      break;
    }
    const acct = accounts[i];
    try {
      const cres = await fetch('https://app.circle.so/api/v1/community_members/' + acct.circle_member_id, {
        headers: { 'Authorization': 'Bearer ' + CIRCLE_TOKEN, 'Accept': 'application/json' }
      });
      if (!cres.ok) {
        failures.push({ id: acct.id, cmid: acct.circle_member_id, status: cres.status });
        stats.errors++;
        continue;
      }
      const member = await cres.json();
      const f = (member && member.flattened_profile_fields) || {};

      // Fill only empty account fields with non-empty Circle values.
      const patch = {};
      CIRCLE_FIELDS.forEach(function (key) {
        const cur = acct[key];
        const incoming = f[key];
        if ((cur == null || String(cur).trim() === '') && incoming != null && String(incoming).trim() !== '') {
          patch[key] = String(incoming).trim().slice(0, key === 'bio' ? 1500 : 300);
        }
      });

      if (!Object.keys(patch).length) { stats.unchanged++; continue; }
      patch.updated_at = new Date().toISOString();

      const ures = await fetch(SUPABASE_URL + '/rest/v1/accounts?id=eq.' + encodeURIComponent(acct.id), {
        method: 'PATCH',
        headers: Object.assign({}, sbHeaders, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
        body: JSON.stringify(patch)
      });
      if (!ures.ok) {
        failures.push({ id: acct.id, reason: 'update', status: ures.status, err: (await ures.text()).slice(0, 150) });
        stats.errors++;
        continue;
      }
      stats.updated++;
    } catch (e) {
      failures.push({ id: acct.id, reason: 'exception', message: e.message });
      stats.errors++;
    }
    // Gentle pacing for the Circle API.
    await new Promise(function (r) { setTimeout(r, 200); });
  }

  await logRow('profile-sync-done', { stats: stats, failures: failures.slice(0, 25) });
  return { statusCode: 202, body: JSON.stringify(stats) };
};

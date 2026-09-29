// netlify/functions/_lib/suppression.js
//
// The email suppression list: addresses SES told us hard-bounced or complained
// (marked us as spam). Senders (onboarding-drip, broadcast-send) check this before
// emailing, so we stop hammering dead or hostile addresses. Writing to it is the
// ses-notifications webhook's job; this module is the shared read/write helper.
//
// Reads FAIL OPEN: if the lookup errors (DB blip), we return "not suppressed" and
// the send proceeds. A suppression-list outage must never silently stop ALL email
// (the same principle the scheduled-guard uses). The cost is that a rare blip can
// let one already-dead address through; SES will just bounce it again.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.

function base() { return (process.env.SUPABASE_URL || '').replace(/\/$/, ''); }
function svcHeaders() {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
}
function norm(email) { return String(email || '').toLowerCase().trim(); }

// Record (or refresh) a suppression. reason: 'bounce' | 'complaint' | 'manual'.
async function suppress(email, opts) {
  const e = norm(email);
  if (!e || e.indexOf('@') === -1) return false;
  if (!base() || !process.env.SUPABASE_SERVICE_KEY) return false;
  opts = opts || {};
  const row = {
    email: e,
    reason: opts.reason || 'bounce',
    bounce_type: opts.bounce_type || null,
    subtype: opts.subtype || null,
    detail: opts.detail ? String(opts.detail).slice(0, 500) : null,
    source: opts.source || 'ses-sns',
    updated_at: new Date().toISOString()
  };
  try {
    // Upsert on the email PK: a repeat bounce refreshes updated_at/reason.
    const r = await fetch(base() + '/rest/v1/email_suppressions?on_conflict=email', {
      method: 'POST',
      headers: Object.assign({ Prefer: 'resolution=merge-duplicates,return=minimal' }, svcHeaders()),
      body: JSON.stringify(row)
    });
    return r.ok;
  } catch (e2) { return false; }
}

// True if this address is suppressed. Fails open (returns false) on any error.
async function isSuppressed(email) {
  const e = norm(email);
  if (!e) return false;
  if (!base() || !process.env.SUPABASE_SERVICE_KEY) return false;
  try {
    const r = await fetch(base() + '/rest/v1/email_suppressions?select=email&email=eq.' +
      encodeURIComponent(e) + '&limit=1', { headers: svcHeaders() });
    if (!r.ok) return false;
    const rows = await r.json();
    return !!(rows && rows.length);
  } catch (e2) { return false; }
}

// Load the whole suppression set once, for filtering a batch (a broadcast run).
// Returns a Set of lowercased addresses. Fails open (empty Set) on error.
async function loadSuppressedSet() {
  const set = new Set();
  if (!base() || !process.env.SUPABASE_SERVICE_KEY) return set;
  try {
    const r = await fetch(base() + '/rest/v1/email_suppressions?select=email&limit=200000',
      { headers: svcHeaders() });
    if (r.ok) {
      const rows = await r.json();
      for (const x of rows) if (x && x.email) set.add(String(x.email).toLowerCase());
    }
  } catch (e) { /* fail open */ }
  return set;
}

module.exports = { suppress, isSuppressed, loadSuppressedSet, norm };

// netlify/functions/_lib/scheduled-guard.js
//
// Shared gate for scheduled jobs. Security audit 2026-09-16, findings H4 and H5.
//
// WHAT WAS WRONG
// Several jobs authorized themselves like this:
//
//     let scheduled = false;
//     try { const b = JSON.parse(event.body || '{}'); if (b.next_run) scheduled = true; } catch (e) {}
//     if (!scheduled) return 403;
//
// `next_run` is a field Netlify puts in the request BODY of a scheduled invocation.
// A body is caller-supplied, so `curl -d '{"next_run":"x"}'` satisfies that check.
// Three other jobs (compliance-reminders, membership-billing-notices,
// phi-purge-expired) had no check at all.
//
// WHAT THIS CAN AND CANNOT DO
// Netlify's scheduler sends no signature or shared secret — only that body. So there
// is NO way to cryptographically distinguish a genuine scheduled invocation from a
// forged one at the application layer. Pretending otherwise is how the original check
// came to look like authorization when it is really just a hint.
//
// So this module splits the two things that were conflated:
//
//   1. AUTHORIZATION, for the manual path only. A human or another service invoking a
//      job out of band must present the shared secret, compared in constant time.
//      The scheduled path is accepted on the `next_run` hint and is explicitly NOT
//      treated as authenticated.
//
//   2. A RUN LOCK, which is what actually limits the damage. A job refuses to run if
//      the same job started within its minimum interval. That makes a forged
//      invocation a no-op regardless of how it got in, which matters most for jobs
//      that are not idempotent — compliance-reminders re-sends its overdue email to
//      every affected member on every run, because only the upcoming-deadline
//      reminders carry a dedupe key (see its _sentReminders handling).
//
// The lock is read-then-insert, not an atomic upsert, so two requests landing in the
// same instant can both claim. That turns unlimited invocations into at most about two
// per window, which is the point; it is not a mutex. It also leaves an audit trail in
// public.function_run_log, a table that already existed but nothing wrote to.

var crypto = require('crypto');

function timingSafeEqual(a, b) {
  var bufA = Buffer.from(String(a || ''));
  var bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function headerOf(event, name) {
  var h = event && event.headers ? event.headers : {};
  return (h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || '').toString().trim();
}

/**
 * Decide whether this invocation may proceed, and say how it got in.
 * @returns {{ok:boolean, via:'secret'|'schedule'|null, authenticated:boolean}}
 *   authenticated is true ONLY for the secret path. A 'schedule' entry is unverified
 *   by construction — callers should rely on the run lock, not on this flag.
 */
function authorize(event, opts) {
  opts = opts || {};
  var secrets = (opts.secrets || []).filter(Boolean);

  // Manual path: a shared secret, from a header or the JSON body.
  var provided = headerOf(event, 'x-job-secret') || headerOf(event, 'x-digest-secret');
  var body = {};
  try { body = JSON.parse((event && event.body) || '{}') || {}; } catch (e) { body = {}; }
  if (!provided && body && typeof body.secret === 'string') provided = body.secret.trim();
  if (!provided && body && typeof body.internal_secret === 'string') provided = body.internal_secret.trim();

  if (provided) {
    for (var i = 0; i < secrets.length; i++) {
      if (timingSafeEqual(provided, secrets[i])) return { ok: true, via: 'secret', authenticated: true };
    }
    // A wrong secret is a refusal, never a fall-through to the weaker path.
    return { ok: false, via: null, authenticated: false };
  }

  // Scheduled path: Netlify's body hint. Unauthenticated on purpose — see the header.
  if (body && body.next_run) return { ok: true, via: 'schedule', authenticated: false };

  return { ok: false, via: null, authenticated: false };
}

function sbHeaders() {
  var KEY = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
}

/**
 * Claim a run slot. Returns {claimed:false, lastRunAt} when the job ran too recently.
 * Fails OPEN: if the log table cannot be read or written, the job still runs. A
 * logging problem must not silently stop the nightly PHI purge or the billing notices.
 */
async function claimRun(functionName, minIntervalMs, via) {
  var URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!URL || !process.env.SUPABASE_SERVICE_KEY) return { claimed: true, runId: null, degraded: true };
  try {
    var since = new Date(Date.now() - (minIntervalMs || 0)).toISOString();
    var res = await fetch(URL + '/rest/v1/function_run_log?function_name=eq.' +
      encodeURIComponent(functionName) + '&started_at=gte.' + encodeURIComponent(since) +
      '&select=started_at&order=started_at.desc&limit=1', { headers: sbHeaders() });
    var rows = res.ok ? await res.json() : [];
    if (rows && rows.length) return { claimed: false, runId: null, lastRunAt: rows[0].started_at };

    var ins = await fetch(URL + '/rest/v1/function_run_log', {
      method: 'POST',
      headers: Object.assign({ Prefer: 'return=representation' }, sbHeaders()),
      body: JSON.stringify({
        function_name: functionName,
        trigger_type: via === 'secret' ? 'manual' : 'schedule',
        started_at: new Date().toISOString()
      })
    });
    var created = ins.ok ? await ins.json() : [];
    return { claimed: true, runId: (created && created[0] && created[0].id) || null };
  } catch (e) {
    return { claimed: true, runId: null, degraded: true };
  }
}

// Close out a run record. Always best-effort.
async function finishRun(runId, ok, summary, errorMessage) {
  if (!runId) return;
  var URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!URL || !process.env.SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(URL + '/rest/v1/function_run_log?id=eq.' + encodeURIComponent(runId), {
      method: 'PATCH',
      headers: Object.assign({ Prefer: 'return=minimal' }, sbHeaders()),
      body: JSON.stringify({
        ok: !!ok,
        // summary is a jsonb column: pass an object straight through rather than
        // stringifying it into a quoted JSON string.
        summary: summary == null ? null : (typeof summary === 'object' ? summary : { note: String(summary).slice(0, 500) }),
        error: errorMessage == null ? null : String(errorMessage).slice(0, 500),
        finished_at: new Date().toISOString()
      })
    });
  } catch (e) { /* best-effort */ }
}

module.exports = { authorize: authorize, claimRun: claimRun, finishRun: finishRun };

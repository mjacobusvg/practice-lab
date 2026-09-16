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
// CORRECTION, VERIFIED 2026-09-16. When this was written I flagged that I had NOT
// established whether these endpoints are reachable over HTTP at all. They are not.
// Netlify refuses HTTP invocation of any function carrying a `schedule` in netlify.toml,
// with a 403 and an EMPTY body — the platform's, returned before the handler runs. Probed
// from outside against production:
//
//   phi-drift-check       scheduled      403, 0-byte body
//   phi-purge-expired     scheduled      403, 0-byte body
//   compliance-reminders  scheduled      403, 0-byte body
//   check-baa-status      not scheduled  401, the handler's own JSON
//   letter-autosend-cron  not scheduled  401, the handler's own JSON
//
// So the forgeable-`next_run` exposure was theoretical on this deployment, not live, and
// my original severity claim on H4/H5 was too high. What is NOT theoretical: the moment a
// job is taken off the schedule list and driven some other way — which is exactly what
// letter-autosend-cron is, a pg_cron-driven job that IS reachable — the platform's refusal
// disappears and only this gate is left. That is the case these checks are written for.
//
// One practical consequence: the secret path below cannot be exercised over HTTP for a
// SCHEDULED job, so such a job cannot be run manually and cannot be smoke-tested that way.
// Its first real run is its next scheduled one.
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

// Every refusal goes through here, so no branch can fail silently. These gates are new
// on jobs that previously ran ungated, and the scheduled path depends on Netlify putting
// `next_run` in event.body for a legacy exports.handler function. Two production jobs
// already rely on that, but if it ever stopped being true a silent 403 would just look
// like the nightly purge quietly not running. Logs the body's SHAPE (keys only, never
// values — a body can carry a secret).
function refuse(name, body, provided) {
  try {
    console.error('[scheduled-guard] refused ' + (name || 'job') +
      ' — body keys: ' + JSON.stringify(Object.keys(body || {})) +
      ', had_secret: ' + (provided ? 'yes(wrong)' : 'no'));
  } catch (e) { /* logging must never throw */ }
  return { ok: false, via: null, authenticated: false };
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
    return refuse(opts.name, body, provided);
  }

  // Scheduled path: Netlify's body hint. Unauthenticated on purpose — see the header.
  if (body && body.next_run) return { ok: true, via: 'schedule', authenticated: false };

  return refuse(opts.name, body, provided);
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

/**
 * Constant-time check of the cron shared secret, accepting the CURRENT value or a
 * PREVIOUS one during a rotation window.
 *
 * Rotating a secret that lives in two places (a Netlify env var and the pg_cron job
 * that sends it) cannot be atomic: whichever side moves first, the other is briefly
 * wrong and every run in the gap fails. Accepting both values removes the gap, so the
 * rotation is: set AUTOSEND_SECRET to the new value and AUTOSEND_SECRET_PREVIOUS to the
 * old one, update the cron side, then delete AUTOSEND_SECRET_PREVIOUS.
 *
 * Also replaces a plain !== comparison, which leaked timing.
 */
function checkCronSecret(event, envNames) {
  var provided = headerOf(event, 'x-autosend-secret');
  if (!provided) return { ok: false, reason: 'missing' };
  var names = envNames || ['AUTOSEND_SECRET', 'AUTOSEND_SECRET_PREVIOUS'];
  var anyConfigured = false;
  for (var i = 0; i < names.length; i++) {
    var expected = process.env[names[i]];
    if (!expected) continue;
    anyConfigured = true;
    if (timingSafeEqual(provided, expected)) {
      return { ok: true, matched: names[i], rotating: i > 0 };
    }
  }
  if (!anyConfigured) return { ok: false, reason: 'not_configured' };
  return { ok: false, reason: 'mismatch' };
}

module.exports.checkCronSecret = checkCronSecret;

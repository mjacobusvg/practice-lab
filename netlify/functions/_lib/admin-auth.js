// netlify/functions/_lib/admin-auth.js
//
// ONE place that decides "is this caller allowed to run an admin endpoint".
// Added for audit finding H9 (2026-09-19).
//
// WHAT H9 WAS
// A single static string, BACKFILL_SECRET, gated roughly twenty capabilities —
// the full member roster including Stripe customer IDs, broadcasting to the entire
// list, subscription migration, embedding backfills, the marketplace funnel. One
// secret, all of it, no way to grant one without granting every one. It was compared
// with `!==` in twenty-three separate handlers, each with its own slightly different
// idea of what a refusal looks like. There was no rate limit, no lockout, and no
// record of a failed attempt anywhere, while every one of those endpoints answers
// `Access-Control-Allow-Origin: *` — so it could be ground down from any browser tab
// and nobody would ever know it had been tried.
//
// WHAT REPLACES IT
// Two accepted ways in, strongest first:
//
//   1. AN ADMIN SESSION. A signed session token, plus a LIVE `accounts.is_admin`
//      read with the service key. The token's own claims are never trusted for
//      this — `is_admin` is not in the token, and if it were, it would be as stale
//      as `tier` was in H8. This is the path that should eventually be the only one:
//      it is per-person, it is revocable (H7), and it leaves the identity in the
//      request rather than in a shared string.
//
//   2. A SHARED SECRET, compared in constant time, for genuine machine-to-machine
//      calls and for the hand-triggered maintenance pages. Still a shared secret —
//      that part of H9 is bounded here, not solved — but no longer the ONLY key,
//      no longer compared with `!==`, no longer silent when it fails, and no longer
//      unlimited in how often it may be guessed.
//
// Endpoints may accept either, or restrict themselves to one (see `opts`).
//
// WHAT THIS DELIBERATELY DOES NOT DO
// It does not decide WHICH admin. Every caller that gets through is fully privileged,
// exactly as before. Splitting these twenty-three capabilities into separate grants
// is the real fix for "one key opens everything", and it is a product decision about
// who should hold what, not something to invent inside an auth helper.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKFILL_SECRET, SESSION_SIGNING_SECRET

const crypto = require('crypto');
const { verifyToken } = require('./session');

// Brute-force bounds. A human pasting a secret into a maintenance page gets it
// wrong once or twice; a script does not stop. Counted per IP across ALL admin
// endpoints, because the secret is shared across them — rate limiting each endpoint
// separately would just mean taking turns.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 8;

function sbHeaders() {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
}

/**
 * Constant-time string comparison.
 *
 * `a !== b` on strings leaks how much of the prefix matched, through timing. That
 * leak is small and awkward to exploit over the internet, but this is free.
 *
 * The length check is the subtle part: crypto.timingSafeEqual THROWS on a length
 * mismatch, which would itself be an obvious oracle and would also turn a wrong
 * secret into a 500. Both sides are hashed to a fixed 32 bytes first, so the
 * comparison is always the same size and length never reaches the branch.
 */
function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function headerOf(event, name) {
  const h = (event && event.headers) || {};
  const v = h[name] || h[String(name).toLowerCase()] || h[String(name).toUpperCase()];
  return typeof v === 'string' ? v.trim() : '';
}

function callerIp(event) {
  const h = (event && event.headers) || {};
  const xff = h['x-nf-client-connection-ip'] || h['client-ip'] || h['x-forwarded-for'] || '';
  return String(xff).split(',')[0].trim() || 'unknown';
}

/** Record a refusal. Best-effort: a logging failure must never decide an auth outcome. */
async function recordFailure(fn, ip, reason, detail) {
  const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!URL || !process.env.SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(URL + '/rest/v1/admin_auth_failures', {
      method: 'POST',
      headers: Object.assign({ Prefer: 'return=minimal' }, sbHeaders()),
      // NEVER the attempted secret. Only which endpoint, from where, and why.
      body: JSON.stringify({ fn: fn || null, ip: ip || null, reason: reason || null,
                             detail: detail ? String(detail).slice(0, 200) : null })
    });
  } catch (e) { /* best-effort */ }
}

/**
 * How many times this IP has failed recently. Returns 0 if we cannot tell.
 *
 * 'unknown' is NOT exempt. Netlify sets x-nf-client-connection-ip, so a caller with
 * no usable IP is the degenerate case — but treating it as "skip the rate limit"
 * would hand anyone an opt-out by stripping a header, which is the whole limit gone.
 * Unknown callers instead share one bucket: conservative, and it cannot lock the
 * owner out of anything, because an admin session does not touch this path at all.
 */
async function recentFailures(ip) {
  const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!URL || !process.env.SUPABASE_SERVICE_KEY) return 0;
  try {
    const since = new Date(Date.now() - FAIL_WINDOW_MS).toISOString();
    const res = await fetch(URL + '/rest/v1/admin_auth_failures?ip=eq.' +
      encodeURIComponent(ip) + '&at=gte.' + encodeURIComponent(since) + '&select=id&limit=1',
      { headers: Object.assign({ Prefer: 'count=exact', Range: '0-0' }, sbHeaders()) });
    if (!res.ok) return 0;
    const range = res.headers.get('content-range') || '';
    const n = parseInt(String(range).split('/')[1], 10);
    return isNaN(n) ? 0 : n;
    // A failed count is 0, not "locked out". Supabase being unreachable must not
    // lock the owner out of his own maintenance tooling; the secret still has to
    // be correct either way.
  } catch (e) { return 0; }
}

/**
 * Authorize an admin caller.
 *
 * @param {object} event   the Netlify event
 * @param {object} opts
 *   name          {string}   endpoint name, for the failure record
 *   secrets       {string[]} accepted shared secrets (default: [BACKFILL_SECRET])
 *   allowSecret   {boolean}  accept the shared-secret path (default true)
 *   allowSession  {boolean}  accept an admin session (default true)
 *   provided      {string}   the presented secret, when the endpoint carries it
 *                            somewhere this helper does not sniff (e.g. the
 *                            reconcile jobs use x-reconcile-secret). Supplying it
 *                            skips the sniffing, it does not add to it.
 * @returns {Promise<{ok, via?, email?, status?, error?}>}
 *   via is 'session' | 'secret'. On refusal, `status` is the HTTP status to answer
 *   with (401 unauthorized, 403 not an admin, 429 rate limited).
 */
async function authorizeAdmin(event, opts) {
  opts = opts || {};
  const name = opts.name || 'admin';
  const ip = callerIp(event);
  const allowSecret = opts.allowSecret !== false;
  const allowSession = opts.allowSession !== false;
  const secrets = (opts.secrets || [process.env.BACKFILL_SECRET]).filter(Boolean);

  let body = {};
  try { body = JSON.parse((event && event.body) || '{}') || {}; } catch (e) { body = {}; }

  // ---- 1) Admin session (strongest) ----
  if (allowSession) {
    const authHeader = headerOf(event, 'authorization');
    const token = String(body.token || authHeader.replace(/^Bearer\s+/i, '') || '').trim();
    if (token) {
      const s = verifyToken(token);
      if (s.valid && s.claims && s.claims.email) {
        const email = String(s.claims.email).toLowerCase().trim();
        const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
        try {
          const res = await fetch(URL + '/rest/v1/accounts?email=eq.' +
            encodeURIComponent(email) + '&select=is_admin&limit=1', { headers: sbHeaders() });
          if (res.ok) {
            const rows = await res.json();
            // `=== true` on purpose: a missing row gives undefined, and undefined
            // must not be admin.
            if (rows && rows[0] && rows[0].is_admin === true) {
              return { ok: true, via: 'session', email: email };
            }
            // A valid session that is NOT an admin is a refusal on its own terms —
            // 403, and it does not fall through to try the secret. Someone signed in
            // as a normal member poking an admin endpoint is worth recording.
            await recordFailure(name, ip, 'not_admin', email);
            return { ok: false, status: 403, error: 'Admins only' };
          }
        } catch (e) { /* fall through to the secret path */ }
      }
    }
  }

  // ---- 2) Shared secret ----
  let provided = typeof opts.provided === 'string' ? opts.provided.trim() : '';
  if (!provided && opts.provided === undefined) {
    provided = headerOf(event, 'x-admin-secret') || headerOf(event, 'x-job-secret');
    if (!provided && typeof body.secret === 'string') provided = body.secret.trim();
    if (!provided && typeof body.internal_secret === 'string') provided = body.internal_secret.trim();
  }

  if (!provided) {
    await recordFailure(name, ip, 'no_credential', null);
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  if (!allowSecret) {
    await recordFailure(name, ip, 'secret_not_accepted', null);
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  // Check the rate limit BEFORE comparing, so grinding cannot be outrun by
  // eventually getting it right.
  const fails = await recentFailures(ip);
  if (fails >= FAIL_LIMIT) {
    await recordFailure(name, ip, 'rate_limited', null);
    return { ok: false, status: 429, error: 'Too many attempts. Try again later.' };
  }

  for (let i = 0; i < secrets.length; i++) {
    if (timingSafeCompare(provided, secrets[i])) return { ok: true, via: 'secret' };
  }

  await recordFailure(name, ip, 'bad_secret', null);
  return { ok: false, status: 401, error: 'Unauthorized' };
}

module.exports = {
  authorizeAdmin,
  timingSafeCompare,
  recordFailure,
  FAIL_WINDOW_MS,
  FAIL_LIMIT
};

// netlify/functions/trial-check.mjs
//
// Server-enforced 7-day trial for the Clinical Note Builder trial clone.
// Keyed to the member's Circle community member ID (falls back to verified email)
// AND to a trial version string, so a major release (HPI gen, Vault Plan, ambient)
// can grant a fresh window by bumping the version the page sends.
//
// The timer is enforced HERE, not in the browser, so clearing localStorage does not
// reset the trial. The page only displays whatever this function returns.
//
// Requires two environment variables in Netlify (these already exist in this project):
//   SUPABASE_URL          e.g. https://ubcrrrapedaxkguxniwv.supabase.co
//   SUPABASE_SERVICE_KEY  service-role key (server-side only; never ship to client)
//
// Table (already created in Supabase):
//   note_builder_trials(community_member_id text, trial_version text, email text,
//                       started_at timestamptz, primary key (community_member_id, trial_version))

import crypto from 'crypto';

// ── Inlined token verification ──────────────────────────────────────────────
// This is verifyToken() from _lib/session.js, inlined deliberately. Netlify's
// ESM (.mjs) bundler does not reliably trace a createRequire('./_lib/session.js')
// dependency into the function bundle, so the relative require can throw
// MODULE_NOT_FOUND at load time -> the function 502s before the handler runs.
// Inlining (crypto is a Node built-in, always present) removes that failure mode.
// Algorithm MUST stay identical to _lib/session.js so tokens verify everywhere.
const SECRET = process.env.SESSION_SIGNING_SECRET || '';

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signPayload(payloadJson) {
  return b64url(crypto.createHmac('sha256', SECRET).update(payloadJson).digest());
}
function verifyToken(token) {
  if (!SECRET) return { valid: false, reason: 'server_misconfigured' };
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) {
    return { valid: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;
  let payloadJson;
  try { payloadJson = b64urlDecode(payloadB64); }
  catch (e) { return { valid: false, reason: 'malformed' }; }
  const expectedSig = signPayload(payloadJson);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'bad_signature' };
  }
  let claims;
  try { claims = JSON.parse(payloadJson); }
  catch (e) { return { valid: false, reason: 'malformed' }; }
  if (!claims.exp || Date.now() > claims.exp) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims };
}
// ────────────────────────────────────────────────────────────────────────────

// Trial length depends on which tool's trial this is. The Note Builder / Chart Coder
// clones run 7 days; the self-serve AI Scribe trial (version 'ai-scribe-v1', started
// when a free/forum member first opens the Scribe) runs 14. Keyed off the version so
// one endpoint serves all trials. Keep the Scribe length in sync with SCRIBE_TRIAL_DAYS
// in clinical-proxy-stream.mjs.
const TRIAL_DAYS_DEFAULT = 7;
function trialDaysFor(version) {
  return /^ai-scribe/i.test(String(version || '')) ? 14 : TRIAL_DAYS_DEFAULT;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Minimal Supabase REST helpers (PostgREST). No client library needed.
async function sbSelect(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`select failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`insert failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { status: 'error', message: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, { status: 'error', message: 'Trial service is not configured.' });
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(400, { status: 'error', message: 'Invalid request body.' });
  }

  const trialVersion = (payload.trialVersion || 'v1').toString().trim();
  const TRIAL_DAYS = trialDaysFor(trialVersion);
  // Read-only mode: report status WITHOUT ever starting a trial. Used by perk pages
  // (e.g. the EPS Quick Reference) that unlock for an already-active trial but must
  // not consume a trial just by being viewed. Returns status 'none' when no row exists.
  const peek = payload.peek === true;

  // Identity from the SIGNED token, never client-declared. Keying the trial to a verified
  // community member id (and verified email) stops trial-farming by varying memberId/email.
  const authHeader = req.headers.get('authorization') || '';
  const sessionToken = (payload.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) {
    return json(401, { status: 'error', message: 'Invalid or expired session.' });
  }
  const memberId = (session.claims.cmid != null ? String(session.claims.cmid) : '').trim();
  const email = (session.claims.email || '').toString().trim().toLowerCase();

  // Key on verified member ID when available; fall back to verified email.
  const keyId = memberId || email;
  if (!keyId) {
    return json(400, { status: 'error', message: 'Missing member identity.' });
  }

  try {
    // Look for an existing trial row for this identity + version.
    const existing = await sbSelect(
      'note_builder_trials',
      `community_member_id=eq.${encodeURIComponent(keyId)}&trial_version=eq.${encodeURIComponent(trialVersion)}&select=started_at`
    );

    const now = Date.now();
    const msInDay = 24 * 60 * 60 * 1000;

    if (existing && existing.length > 0) {
      const startedAt = new Date(existing[0].started_at).getTime();
      const elapsedDays = (now - startedAt) / msInDay;
      const daysLeft = Math.max(0, Math.ceil(TRIAL_DAYS - elapsedDays));
      if (elapsedDays < TRIAL_DAYS) {
        return json(200, { status: 'active', daysLeft });
      }
      return json(200, { status: 'expired' });
    }

    // No row yet. In peek mode, report 'none' and do NOT start a trial.
    if (peek) {
      return json(200, { status: 'none' });
    }

    // No row yet: start the trial now.
    await sbInsert('note_builder_trials', {
      community_member_id: keyId,
      trial_version: trialVersion,
      email: email || null,
      started_at: new Date(now).toISOString(),
    });
    return json(200, { status: 'active', daysLeft: TRIAL_DAYS });
  } catch (err) {
    return json(500, { status: 'error', message: 'Trial lookup failed. Please try again.' });
  }
};

// Netlify ESM functions with a default export need an explicit path config to route
// reliably. Without it the endpoint can return the platform error page (non-JSON),
// which the trial page surfaces as "Connection error reaching the trial service."
export const config = { path: '/.netlify/functions/trial-check' };

// netlify/functions/log-error.js
// Client-side error sink. The platform's global error handlers POST here when a
// script error or unhandled rejection fires, so failures that would otherwise
// die silently in a member's browser become visible to the admin.
//
// Best-effort and defensive: never throws back to the page, caps field sizes,
// and attributes the error to a member only if a valid session token is present
// (we never trust a client-supplied email).
//
// Body: { message, stack?, page?, ua?, token? }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET (via _lib/session)

const { verifyToken } = require('./_lib/session');

function clip(v, n) { return v == null ? null : String(v).slice(0, n); }

// ── PHI guards ───────────────────────────────────────────────────────────────
// This table lives in Supabase, which has NO BAA, and pm-ai-scribe.html posts here.
// A thrown Error can carry whatever it was handed — `new Error('save failed: ' +
// noteText)` or a JSON.parse failure quoting its input — so neither field may be
// stored raw. Audit finding M3.

// Replace identifier-SHAPED substrings. Same deterministic patterns as the second
// pass in deidentify-note.js, kept narrow: this is a safety net over machine-written
// error text, not a de-identifier for prose.
function scrubIdentifiers(s) {
  return String(s == null ? '' : s)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]')
    .replace(/\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[PHONE]')
    .replace(/\b(0?[1-9]|1[0-2])[\/\-.](0?[1-9]|[12]\d|3[01])[\/\-.](\d{4}|\d{2})\b/g, '[DATE]')
    .replace(/\b(?:MRN|Medical Record(?: Number)?|Acct(?:ount)?|Member(?:\s*ID)?|Policy|Chart)\s*#?:?\s*[A-Z0-9-]{4,}\b/gi, '[ID]')
    .replace(/\b\d{7,}\b/g, '[ID]');
}

// A stack is only useful as FRAMES. Keep the lines that look like one
// ("  at fn (https://host/file.js:12:34)" or a bare "file.js:12:34") and drop
// everything else, which is where interpolated content would sit. Then scrub and
// cap hard — 600 chars is ~6 frames, plenty to locate a bug.
function safeStack(v) {
  if (v == null) return null;
  const frames = String(v)
    .split('\n')
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return /^at\s/.test(l) || /:\d+:\d+\)?$/.test(l); });
  if (!frames.length) return null;
  return scrubIdentifiers(frames.join('\n')).slice(0, 600);
}

// Error messages are free text, so they get the scrub plus a much tighter cap.
function safeMessage(v) {
  if (v == null) return null;
  return scrubIdentifiers(String(v)).slice(0, 300) || null;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }; // swallow

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }; }
  const message = clip(p.message, 1000);
  if (!message) return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  // Failed "email me a sign-in link" attempts get their own table so login problems
  // (especially email rate-limit blocks) are countable, not mixed with JS errors.
  if (p.kind === 'signin_email') {
    try {
      await fetch(URL + '/rest/v1/signin_email_failures', {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          email: clip(String(p.email || '').toLowerCase(), 200),
          error: message,
          page: clip(p.page, 300),
          user_agent: clip(p.ua || event.headers['user-agent'], 400)
        })
      });
    } catch (e) { /* best-effort */ }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // Drop known browser/extension noise before it reaches the admin error panel:
  // crypto-wallet injectors (window.ethereum / selectedAddress), Firefox reader
  // internals (__firefox__), extension frames (chrome-/moz-/safari-extension),
  // benign ResizeObserver loops, and the opaque cross-origin "Script error."
  // placeholder. These fire inside the member's own extensions, never our code,
  // cannot affect the member, and only bury real bugs. Swallowed (never stored).
  const noiseHay = message + ' ' + (p.stack || '');
  const NOISE = /window\.ethereum|selectedAddress|__firefox__|ResizeObserver loop|chrome-extension:\/\/|moz-extension:\/\/|safari-web-extension:\/\/|metamask/i;
  if (NOISE.test(noiseHay) || /^\s*script error\.?\s*$/i.test(message)) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'noise' }) };
  }

  let email = null, tier = null;
  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    if (token) {
      const s = verifyToken(token);
      if (s.valid) { email = String(s.claims.email || '').toLowerCase() || null; tier = s.claims.tier || null; }
    }
  } catch (e) { /* anon is fine */ }

  try {
    await fetch(URL + '/rest/v1/client_errors', {
      method: 'POST',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        email: email, tier: tier,
        page: clip(p.page, 300), message: safeMessage(message),
        stack: safeStack(p.stack), user_agent: clip(p.ua || event.headers['user-agent'], 400)
      })
    });
  } catch (e) { /* best-effort */ }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};

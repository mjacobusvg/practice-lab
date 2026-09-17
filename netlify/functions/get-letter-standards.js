const { verifyToken } = require('./_lib/session');

// Does this member hold an unexpired pass for a named feature? Mirrors
// clinical-proxy.js hasActiveEntitlement so a forum-tier member with a hand-granted
// 'letter_generator' trial reads the standards their tool is allowed to use. SELECT
// only; grants expire at expires_at on their own. Fails CLOSED on any error.
async function hasActiveEntitlement(email, feature) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  const em = (email || '').toString().trim().toLowerCase();
  if (!em || !feature) return false;
  try {
    const nowIso = new Date().toISOString();
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/feature_entitlements?email=eq.' + encodeURIComponent(em) +
      '&feature=eq.' + encodeURIComponent(feature) +
      '&expires_at=gt.' + encodeURIComponent(nowIso) + '&select=id&limit=1',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    return false;
  }
}

// netlify/functions/get-letter-standards.js
// Returns active TBP Clinical Letter Standards.
// Uses Supabase REST API directly (no SDK dependency).
//
// GET /.netlify/functions/get-letter-standards
//   Authorization: Bearer <session token>   (REQUIRED — full tier, or a live
//                                            'letter_generator' entitlement)
//   ?standard_key=esa                       (optional - filter to one category)
//
// A ?email= parameter is NOT honoured and never was; the member's own templates are
// unlocked from the token's identity.

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server misconfigured: missing Supabase credentials' })
    };
  }

  const qs = event.queryStringParameters || {};
  const standardKey = (qs.standard_key || '').trim();

  // Identity from the SIGNED token, never from a client-supplied ?email=.
  //
  // SECURITY 2026-09-17. This used to fall through to "only system standards are
  // returned (still useful, not user-scoped, safe to cache)" when there was no valid
  // token — which meant an unauthenticated GET returned every active system standard
  // with its full body_template, spec and conditional_blocks. Measured before the fix:
  // 77,911 bytes to a caller presenting nothing. Those templates are the Letter
  // Generator; they are versioned through the editorial review in
  // LETTER-STANDARDS-REVIEW.md and are the product, not marketing copy. The table's
  // anon SELECT grant was revoked the same day, but that only closed the direct REST
  // path — this endpoint was the wider one.
  //
  // The tool's own gate is requireFull PLUS feature 'letter_generator', because a
  // forum-tier member can hold a hand-granted trial pass. Checking tier === 'full'
  // alone would lock those members out of a tool they are entitled to, so this mirrors
  // the gate exactly, the same way clinical-proxy.js re-checks it.
  let email = '';
  let isFull = false;
  let bodyObj = {};
  if (event.httpMethod === 'POST') {
    try { bodyObj = JSON.parse(event.body || '{}'); } catch (e) { bodyObj = {}; }
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (bodyObj.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  if (!sessionToken) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Sign in to load the letter standards.' }) };
  }
  const session = verifyToken(sessionToken);
  if (!session.valid || session.claims.scope !== 'member') {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }
  email = (session.claims.email || '').toLowerCase().trim();
  if (!email) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session missing identity.' }) };
  }
  isFull = session.claims.tier === 'full';
  if (!isFull) {
    const entitled = await hasActiveEntitlement(email, 'letter_generator');
    if (!entitled) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'The Letter Generator is a full-membership tool.' }) };
    }
  }

  // Build Supabase REST URL with PostgREST filters
  const selectCols = 'id,standard_key,variant_key,version,category_label,variant_label,short_description,spec,body_template,placeholders,conditional_blocks,optional_toggles,authored_by,author_name,is_system,is_shared_to_group,status,created_at,updated_at';

  let url = SUPABASE_URL + '/rest/v1/tbp_letter_standards'
    + '?select=' + encodeURIComponent(selectCols)
    + '&status=eq.active'
    + '&order=standard_key.asc,variant_key.asc';

  if (email) {
    url += '&or=(is_system.eq.true,authored_by.eq.' + encodeURIComponent(email) + ')';
  } else {
    url += '&is_system=eq.true';
  }

  if (standardKey) {
    url += '&standard_key=eq.' + encodeURIComponent(standardKey);
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': 'Bearer ' + SERVICE_KEY,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[get-letter-standards] Supabase error:', response.status, text);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Supabase returned ' + response.status, detail: text })
      };
    }

    const data = await response.json();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        standards: data || [],
        count: (data || []).length,
        retrieved_at: new Date().toISOString()
      })
    };
  } catch (err) {
    console.error('[get-letter-standards] fetch error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal error' })
    };
  }
};

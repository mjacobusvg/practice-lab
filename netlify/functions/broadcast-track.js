// netlify/functions/broadcast-track.js
// Open + click tracking for broadcast emails (the same delivered/opened/clicked
// numbers Circle showed). Each broadcast email embeds:
//   - a 1x1 pixel:  ?b=<broadcast_id>&e=<signed email>&k=open
//   - rewritten links: ?b=<broadcast_id>&e=<signed email>&k=click&u=<b64url target>
// We log the event (best-effort) and then return the pixel or 302 to the target.
//
// The email is carried as a signed prefs token so we log a real recipient, not an
// attacker-supplied address. The broadcast id is a plain uuid (not secret).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyPrefsToken } = require('./_lib/prefs-token');

// 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function b64urlDecode(str) {
  try {
    str = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
  } catch (e) { return ''; }
}

function pixelResponse() {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', 'Content-Length': String(PIXEL.length) },
    body: PIXEL.toString('base64'),
    isBase64Encoded: true
  };
}

exports.handler = async function (event) {
  const qp = event.queryStringParameters || {};
  const kind = qp.k === 'click' ? 'click' : 'open';
  const bid = String(qp.b || '').trim();
  const v = verifyPrefsToken(qp.e || '');
  const email = v.valid ? v.email : null;
  const target = kind === 'click' ? b64urlDecode(qp.u) : null;

  // Log best-effort; never let logging failure break the pixel/redirect.
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (URL && KEY && bid && email && /^[0-9a-f-]{36}$/i.test(bid)) {
    try {
      await fetch(URL + '/rest/v1/broadcast_events', {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ broadcast_id: bid, email: email, kind: kind, url: target || null })
      });
    } catch (e) { /* best-effort */ }
  }

  if (kind === 'click') {
    // Only redirect to http(s) targets we can parse; otherwise fall back home.
    var dest = (target && /^https?:\/\//i.test(target)) ? target : 'https://thinkbeyondpractice.com/platform.html';
    return { statusCode: 302, headers: { Location: dest, 'Cache-Control': 'no-store' }, body: '' };
  }
  return pixelResponse();
};

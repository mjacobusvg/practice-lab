// netlify/functions/broadcast-unsub.js
// One-click unsubscribe from broadcast emails. The footer link in every
// broadcast carries a signed, non-expiring token (mintPrefsToken) identifying
// the recipient's email. Visiting the link flips contacts.subscribed=false and
// returns a small confirmation page. No login required (CAN-SPAM one-click).
//
// GET /.netlify/functions/broadcast-unsub?t=<token>
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyPrefsToken } = require('./_lib/prefs-token');

function page(title, msg) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title></head>' +
    '<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f6f8;margin:0;padding:48px 16px;color:#1a2430">' +
    '<div style="max-width:460px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,.08)">' +
    '<h1 style="font-size:19px;margin:0 0 10px">' + title + '</h1>' +
    '<p style="font-size:15px;line-height:1.6;color:#44515e;margin:0">' + msg + '</p>' +
    '</div></body></html>';
}

exports.handler = async function (event) {
  const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  const t = (event.queryStringParameters && event.queryStringParameters.t) || '';
  const v = verifyPrefsToken(t);
  if (!v.valid) {
    return { statusCode: 400, headers: htmlHeaders, body: page('Link not valid', 'This unsubscribe link could not be verified. Please use the link from a recent email, or reply to let us know.') };
  }

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers: htmlHeaders, body: page('Something went wrong', 'Please try again shortly.') };
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  try {
    await fetch(URL + '/rest/v1/contacts?email=eq.' + encodeURIComponent(v.email), {
      method: 'PATCH',
      headers: Object.assign({ Prefer: 'return=minimal' }, auth),
      body: JSON.stringify({ subscribed: false, unsubscribed_at: new Date().toISOString() })
    });
  } catch (e) { /* fall through to a friendly page regardless */ }

  // Attribute the unsubscribe to the broadcast it came from (for per-send stats).
  var bid = (event.queryStringParameters && event.queryStringParameters.b) || '';
  if (bid && /^[0-9a-f-]{36}$/i.test(bid)) {
    try {
      await fetch(URL + '/rest/v1/broadcast_events', {
        method: 'POST', headers: Object.assign({ Prefer: 'return=minimal' }, auth),
        body: JSON.stringify({ broadcast_id: bid, email: v.email, kind: 'unsub' })
      });
    } catch (e) { /* best-effort */ }
  }

  return { statusCode: 200, headers: htmlHeaders, body: page('You are unsubscribed', 'You will no longer receive broadcast emails from Think Beyond Practice. You can still sign in to the platform anytime. If this was a mistake, just reply to any of our emails and we will add you back.') };
};

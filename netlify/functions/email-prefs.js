// netlify/functions/email-prefs.js
// Read/update a member's email notification preferences from a signed email-prefs
// token (no login). The token authorizes exactly this one account's notify_email_*
// flags and nothing else. Writes with the service key (these columns are locked
// from the anon client).
//
// Body: { t, action:'get' }              -> { ok, email, prefs:{posts,comments,dms} }
//       { t, action:'save', prefs:{...} } -> { ok }

const { verifyPrefsToken } = require('./_lib/prefs-token');

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }

  const v = verifyPrefsToken(String(p.t || '').trim());
  if (!v.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'This link is invalid or has expired.' }) };
  const email = v.email;
  const emailFilter = 'email=eq.' + encodeURIComponent(email);
  const sbHeaders = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

  try {
    if (p.action === 'save') {
      const inp = p.prefs || {};
      const patch = {
        notify_email_posts: !!inp.posts,
        notify_email_comments: !!inp.comments,
        notify_email_dms: !!inp.dms,
        updated_at: new Date().toISOString()
      };
      const res = await fetch(URL + '/rest/v1/accounts?' + emailFilter, {
        method: 'PATCH', headers: Object.assign({}, sbHeaders, { Prefer: 'return=minimal' }), body: JSON.stringify(patch)
      });
      if (!res.ok) throw new Error('Supabase ' + res.status);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // Default: get.
    const res = await fetch(URL + '/rest/v1/accounts?' + emailFilter + '&select=name,notify_email_posts,notify_email_comments,notify_email_dms&limit=1', { headers: sbHeaders });
    const rows = await res.json();
    const a = (rows && rows[0]) || {};
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, email: email, name: a.name || '', prefs: { posts: a.notify_email_posts !== false, comments: a.notify_email_comments !== false, dms: a.notify_email_dms !== false } }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

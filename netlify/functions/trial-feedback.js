// netlify/functions/trial-feedback.js
// One-click "why didn't it stick?" capture for the trial emails.
//
// The old ask was "just reply" — which asks somebody who has already decided
// not to buy to open a blank compose window and author prose. This replaces it
// with a link per reason:
//
//   GET  ?e=<signed email>&s=<stage>&r=<reason>   → record, 302 to the thank-you page
//   POST { e, note }                              → attach the optional free text
//
// The email is carried as a signed prefs token, the same one broadcast-track and
// the unsubscribe links use, so we record a real recipient rather than whatever
// address someone puts in the query string. A person can change their mind: the
// unique index on (email, stage) means a second click updates the first.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyPrefsToken } = require('./_lib/prefs-token');

const SITE = 'https://thinkbeyondpractice.com';
const REASONS = ['no-time', 'notes', 'price', 'have-one', 'missing', 'technical', 'other'];
const STAGES = ['ending', 'expired'];

function sbHeaders(KEY, extra) {
  return Object.assign({
    apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json'
  }, extra || {});
}

function redirect(to) {
  return { statusCode: 302, headers: { Location: to, 'Cache-Control': 'no-store' }, body: '' };
}

function json(code, obj) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj)
  };
}

exports.handler = async function (event) {
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;

  // ---- POST: the optional free-text note from the thank-you page ----
  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad json' }); }

    const v = verifyPrefsToken(body.e || '');
    if (!v.valid) return json(403, { error: 'bad token' });

    const note = String(body.note || '').trim().slice(0, 2000);
    if (!note) return json(400, { error: 'empty note' });
    if (!URL || !KEY) return json(500, { error: 'not configured' });

    const stage = STAGES.indexOf(String(body.s || '')) !== -1 ? String(body.s) : null;
    try {
      // Attach to this person's row for the stage they came from; if the stage is
      // missing or unknown, fall back to their most recent row.
      const filter = '?email=eq.' + encodeURIComponent(v.email)
        + (stage ? '&stage=eq.' + stage : '')
        + '&order=created_at.desc&limit=1';
      const rows = await fetch(URL + '/rest/v1/trial_feedback' + filter, { headers: sbHeaders(KEY) });
      const found = rows.ok ? await rows.json() : [];
      if (!found.length) return json(404, { error: 'no feedback row' });

      await fetch(URL + '/rest/v1/trial_feedback?id=eq.' + found[0].id, {
        method: 'PATCH',
        headers: sbHeaders(KEY, { Prefer: 'return=minimal' }),
        body: JSON.stringify({ note: note, noted_at: new Date().toISOString() })
      });
      return json(200, { ok: true });
    } catch (e) {
      return json(500, { error: 'save failed' });
    }
  }

  // ---- GET: the one-click reason itself ----
  const qp = event.queryStringParameters || {};
  const v = verifyPrefsToken(qp.e || '');
  const reason = REASONS.indexOf(String(qp.r || '')) !== -1 ? String(qp.r) : null;
  const stage = STAGES.indexOf(String(qp.s || '')) !== -1 ? String(qp.s) : 'expired';

  // A bad or missing token still lands somewhere sensible rather than an error page.
  if (!v.valid || !reason) return redirect(SITE + '/trial-feedback.html?ok=0');

  if (URL && KEY) {
    try {
      // Upsert on (email, stage): changing your mind replaces the earlier answer
      // and clears any note that belonged to it.
      await fetch(URL + '/rest/v1/trial_feedback?on_conflict=email,stage', {
        method: 'POST',
        headers: sbHeaders(KEY, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({
          email: v.email, stage: stage, reason: reason,
          note: null, noted_at: null, created_at: new Date().toISOString()
        })
      });
    } catch (e) { /* best-effort: never block the redirect on logging */ }
  }

  return redirect(SITE + '/trial-feedback.html?ok=1&r=' + encodeURIComponent(reason)
    + '&s=' + encodeURIComponent(stage) + '&e=' + encodeURIComponent(qp.e || ''));
};

// netlify/functions/send-scheduled-broadcasts.js
//
// Scheduled: every 10 minutes. Sends any broadcast in scheduled_broadcasts whose
// time has come, by calling broadcast-send with the internal secret. This is what
// makes "Schedule broadcast" (e.g. Sunday 8am) actually fire.
//
// Double-send safe: each due row is CLAIMED first (status scheduled -> sending,
// only if still scheduled). If the claim returns no row, another run already took
// it, so we skip. On success -> sent; on failure -> error (with the reason).
//
// Trigger: the Netlify scheduler (body carries next_run) or a manual POST with
// { secret: BACKFILL_SECRET }.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKFILL_SECRET, URL (Netlify site URL)

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, SECRET = process.env.BACKFILL_SECRET;
  if (!URL || !KEY || !SECRET) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env' }) };

  // Authorize: Netlify scheduler (body has next_run) or the manual secret.
  let scheduled = false;
  try { const b = JSON.parse(event.body || '{}'); if (b && b.next_run) scheduled = true; if (b && b.secret === SECRET) scheduled = true; } catch (e) {}
  if (!scheduled) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };

  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://thinkbeyondpractice.com';
  const nowIso = new Date().toISOString();

  try {
    // Find due, still-scheduled broadcasts.
    const dueRes = await fetch(URL + '/rest/v1/scheduled_broadcasts?status=eq.scheduled&scheduled_at=lte.' + encodeURIComponent(nowIso) + '&order=scheduled_at.asc&select=id,subject,markdown,preheader,audience,emails&limit=20', { headers: auth });
    const due = dueRes.ok ? await dueRes.json() : [];
    const results = [];

    for (const b of due) {
      // Claim it: flip scheduled -> sending only if still scheduled. Empty result
      // means another run already claimed it — skip.
      const claim = await fetch(URL + '/rest/v1/scheduled_broadcasts?id=eq.' + b.id + '&status=eq.scheduled', {
        method: 'PATCH', headers: Object.assign({}, auth, { Prefer: 'return=representation' }),
        body: JSON.stringify({ status: 'sending' })
      });
      const claimed = claim.ok ? await claim.json() : [];
      if (!claimed.length) continue;

      try {
        const sendRes = await fetch(base + '/.netlify/functions/broadcast-send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ internal_secret: SECRET, subject: b.subject, markdown: b.markdown, preheader: b.preheader || '', audience: b.audience, emails: b.emails || '' })
        });
        const sd = await sendRes.json().catch(function () { return {}; });
        if (sendRes.ok && sd.ok) {
          await patch(URL, auth, b.id, { status: 'sent', sent_at: new Date().toISOString(), broadcast_id: sd.broadcast_id || null });
          results.push({ id: b.id, sent: sd.sent });
        } else {
          await patch(URL, auth, b.id, { status: 'error', error: String(sd.error || ('send ' + sendRes.status)).slice(0, 300) });
          results.push({ id: b.id, error: sd.error || sendRes.status });
        }
      } catch (e) {
        await patch(URL, auth, b.id, { status: 'error', error: String(e.message).slice(0, 300) });
        results.push({ id: b.id, error: e.message });
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, due: due.length, results }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

function patch(URL, auth, id, body) {
  return fetch(URL + '/rest/v1/scheduled_broadcasts?id=eq.' + id, {
    method: 'PATCH', headers: Object.assign({}, auth, { Prefer: 'return=minimal' }), body: JSON.stringify(body)
  });
}

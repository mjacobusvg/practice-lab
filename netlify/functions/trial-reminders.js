// netlify/functions/trial-reminders.js
//
// Scheduled daily. Emails AI Scribe trial users ~2 days before their 14-day
// trial ends, nudging them to join Full before it lapses. Exactly one reminder
// per trial, tracked by note_builder_trials.reminder_sent_at. Anyone who has
// already converted to a paid tier is skipped (stamped, never emailed).
//
// Sends through broadcast-send (audience 'custom') with the internal secret, so
// it reuses list-unsubscribe, {{first_name}} personalization, and open/click
// tracking. This is the "your trial is ending" nudge that turns a silent expiry
// into a conversion.
//
// Double-send safe: each due trial is CLAIMED (reminder_sent_at set) before the
// email goes out; if the send fails the claim is released so a later run retries.
//
// Trigger: the Netlify scheduler (body carries next_run) or a manual POST with
// { secret: BACKFILL_SECRET }.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKFILL_SECRET, URL (Netlify site URL)

const TRIAL_DAYS = 14;         // keep in sync with trial-check.mjs (ai-scribe-v1)
const REMIND_BEFORE_DAYS = 2;  // send when about this many days remain

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, SECRET = process.env.BACKFILL_SECRET;
  if (!URL || !KEY || !SECRET) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env' }) };

  // Authorize: Netlify scheduler (body has next_run) or the manual secret.
  let ok = false;
  try { const b = JSON.parse(event.body || '{}'); if (b && b.next_run) ok = true; if (b && b.secret === SECRET) ok = true; } catch (e) {}
  if (!ok) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };

  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://thinkbeyondpractice.com';
  const now = Date.now();
  const msDay = 86400000;
  // Still-active trials with about REMIND_BEFORE_DAYS or fewer left, not yet reminded:
  //   started_at <= now - (TRIAL_DAYS - REMIND_BEFORE_DAYS)   (inside the reminder window)
  //   started_at >  now - TRIAL_DAYS                          (not already expired)
  const startedBeforeIso = new Date(now - (TRIAL_DAYS - REMIND_BEFORE_DAYS) * msDay).toISOString();
  const startedAfterIso = new Date(now - TRIAL_DAYS * msDay).toISOString();

  try {
    const q = '/rest/v1/note_builder_trials?trial_version=eq.ai-scribe-v1'
      + '&started_at=lte.' + encodeURIComponent(startedBeforeIso)
      + '&started_at=gt.' + encodeURIComponent(startedAfterIso)
      + '&reminder_sent_at=is.null'
      + '&select=community_member_id,email,started_at&limit=200';
    const dueRes = await fetch(URL + q, { headers: auth });
    const due = dueRes.ok ? await dueRes.json() : [];
    const results = [];

    for (const t of due) {
      const email = String(t.email || '').toLowerCase().trim();
      const idFilter = '?community_member_id=eq.' + encodeURIComponent(t.community_member_id) + '&trial_version=eq.ai-scribe-v1';

      // Claim it: set reminder_sent_at only if still null. Empty result => another
      // run already took it, so skip.
      const claim = await fetch(URL + '/rest/v1/note_builder_trials' + idFilter + '&reminder_sent_at=is.null', {
        method: 'PATCH', headers: Object.assign({}, auth, { Prefer: 'return=representation' }),
        body: JSON.stringify({ reminder_sent_at: new Date().toISOString() })
      });
      const claimed = claim.ok ? await claim.json() : [];
      if (!claimed.length) continue;

      if (!email || email.indexOf('@') === -1) { results.push({ id: t.community_member_id, skip: 'no email' }); continue; }

      // Already a paying member? Nothing to nudge — leave it stamped so we never revisit.
      try {
        const ar = await fetch(URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=tier&limit=1', { headers: auth });
        const arows = ar.ok ? await ar.json() : [];
        const tier = arows[0] && String(arows[0].tier || '').toLowerCase();
        if (tier === 'full' || tier === 'forum') { results.push({ email, skip: 'already ' + tier }); continue; }
      } catch (e) { /* if the tier lookup fails, still send the reminder */ }

      const daysLeft = Math.max(1, Math.ceil(TRIAL_DAYS - (now - new Date(t.started_at).getTime()) / msDay));
      const subject = daysLeft <= 1 ? 'Your AI Scribe trial ends tomorrow' : ('Your AI Scribe trial ends in ' + daysLeft + ' days');
      const preheader = 'Keep the AI Scribe, the Chart Auditor, and the whole clinical suite.';
      const markdown = reminderMarkdown(daysLeft);

      try {
        const sendRes = await fetch(base + '/.netlify/functions/broadcast-send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            internal_secret: SECRET, subject: subject, preheader: preheader, markdown: markdown,
            audience: 'custom', emails: email,
            from: 'Michael Van Gelder <michael@thinkbeyondpractice.com>'
          })
        });
        const sd = await sendRes.json().catch(function () { return {}; });
        if (sendRes.ok && sd.ok) {
          results.push({ email: email, sent: sd.sent });
        } else {
          // Send failed: release the claim so a later run retries.
          await release(URL, auth, idFilter);
          results.push({ email: email, error: sd.error || sendRes.status });
        }
      } catch (e) {
        await release(URL, auth, idFilter);
        results.push({ email: email, error: e.message });
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, due: due.length, results: results }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

function release(URL, auth, idFilter) {
  return fetch(URL + '/rest/v1/note_builder_trials' + idFilter, {
    method: 'PATCH', headers: Object.assign({}, auth, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ reminder_sent_at: null })
  });
}

function reminderMarkdown(daysLeft) {
  const when = daysLeft <= 1 ? 'tomorrow' : ('in ' + daysLeft + ' days');
  return [
    'Hi {{first_name}},',
    '',
    'Your free 2-week trial of the AI Scribe ends ' + when + '. I did not want you to lose it by accident.',
    '',
    'If it has earned a place in your workflow, Full membership keeps the AI Scribe and the Chart Audit + Coder, and adds the whole clinical suite, the case discussions, and everything else inside Think Beyond Practice for $119/month. Your templates and settings are saved and waiting.',
    '',
    '[Keep the AI Scribe — become a member →](https://thinkbeyondpractice.com/platform?plan=full_monthly_119)',
    '',
    'Not ready? No problem, and no card was ever charged. You can pick it back up whenever the timing is right.',
    '',
    'And if it did not click for you, I would genuinely like to know why. Just reply to this email and tell me.',
    '',
    '— Michael',
    '',
    'P.S. Membership comes with a 15-day money-back guarantee, so joining is not a one-way door.'
  ].join('\n');
}

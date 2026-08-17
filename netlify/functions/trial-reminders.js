// netlify/functions/trial-reminders.js
//
// Scheduled daily. Drives the LATE half of the AI Scribe trial lifecycle — the
// part the onboarding-drip (days 0-7, for every new free member) does not cover
// because it is not trial-aware. Two stages, one email each, once per trial:
//
//   ending   ~day 12  "Your AI Scribe trial ends in 2 days"  (reminder_sent_at)
//   expired  ~day 14+  "Your trial has ended, your work is saved" (expired_sent_at)
//
// Both fire AFTER the onboarding-drip finishes at day 7, so there is no overlap.
// Anyone already on a paid tier is skipped (stamped, never emailed). Sends through
// broadcast-send (audience 'custom') so it reuses list-unsubscribe, {{first_name}}
// personalization, and open/click tracking.
//
// Double-send safe: each due trial is CLAIMED (its stage column set) before the
// email goes out; if the send fails the claim is released so a later run retries.
//
// Trigger: the Netlify scheduler (body carries next_run) or a manual POST with
// { secret: BACKFILL_SECRET }.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKFILL_SECRET, URL (Netlify site URL)

const TRIAL_DAYS = 14; // keep in sync with trial-check.mjs (ai-scribe-v1)
const FROM = 'Michael Van Gelder <michael@thinkbeyondpractice.com>';
const JOIN = 'https://thinkbeyondpractice.com/platform?plan=full_monthly_119';

// Each stage: the column that tracks its one send, and the age window (days since
// started_at) during which it is due. Windows sit after the onboarding-drip (day 7)
// and do not overlap each other.
const STAGES = [
  {
    key: 'ending', sentCol: 'reminder_sent_at', minAgeDays: 12, maxAgeDays: 14,
    subject: function (daysLeft) { return daysLeft <= 1 ? 'Your AI Scribe trial ends tomorrow' : ('Your AI Scribe trial ends in ' + daysLeft + ' days'); },
    preheader: 'Keep the AI Scribe, the Chart Auditor, and the whole clinical suite.',
    markdown: function (daysLeft) {
      const when = daysLeft <= 1 ? 'tomorrow' : ('in ' + daysLeft + ' days');
      return [
        'Hi {{first_name}},',
        '',
        'Your free 2-week trial of the AI Scribe ends ' + when + '. I did not want you to lose it by accident.',
        '',
        'If it has earned a place in your workflow, Full membership keeps the AI Scribe and the Chart Audit + Coder, and adds the whole clinical suite, the case discussions, and everything else inside Think Beyond Practice for $119/month. Your templates and settings are saved and waiting.',
        '',
        '[Keep the AI Scribe — become a member →](' + JOIN + ')',
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
  },
  {
    key: 'expired', sentCol: 'expired_sent_at', minAgeDays: 14, maxAgeDays: 16,
    subject: function () { return 'Your AI Scribe trial has ended — your work is saved'; },
    preheader: 'Your templates and settings are waiting whenever you are ready.',
    markdown: function () {
      return [
        'Hi {{first_name}},',
        '',
        'Your free 2-week trial of the AI Scribe has ended. Nothing was charged, and nothing is lost — your templates and settings are saved exactly where you left them.',
        '',
        'If it made your documentation easier, Full membership brings the AI Scribe and the Chart Audit + Coder back, plus the whole clinical suite, the case discussions, and everything else inside Think Beyond Practice for $119/month. You would pick up right where you stopped.',
        '',
        '[Continue with Full membership →](' + JOIN + ')',
        '',
        'And if it did not fit your workflow, I would honestly value knowing why — it is how the Scribe gets better. Just reply.',
        '',
        '— Michael',
        '',
        'P.S. Membership comes with a 15-day money-back guarantee, so there is a way back out if it is not right.'
      ].join('\n');
    }
  }
];

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
  const results = [];

  try {
    for (const stage of STAGES) {
      // Due = started inside this stage's age window, this stage not yet sent.
      //   age >= minAge  <=>  started_at <= now - minAge
      //   age <  maxAge  <=>  started_at >  now - maxAge
      const startedBefore = new Date(now - stage.minAgeDays * msDay).toISOString();
      const startedAfter = new Date(now - stage.maxAgeDays * msDay).toISOString();
      const q = '/rest/v1/note_builder_trials?trial_version=eq.ai-scribe-v1'
        + '&started_at=lte.' + encodeURIComponent(startedBefore)
        + '&started_at=gt.' + encodeURIComponent(startedAfter)
        + '&' + stage.sentCol + '=is.null'
        + '&select=community_member_id,email,started_at&limit=200';
      const dueRes = await fetch(URL + q, { headers: auth });
      const due = dueRes.ok ? await dueRes.json() : [];

      for (const t of due) {
        const email = String(t.email || '').toLowerCase().trim();
        const idFilter = '?community_member_id=eq.' + encodeURIComponent(t.community_member_id) + '&trial_version=eq.ai-scribe-v1';

        // Claim it: set this stage's column only if still null. Empty result => taken.
        const claim = await fetch(URL + '/rest/v1/note_builder_trials' + idFilter + '&' + stage.sentCol + '=is.null', {
          method: 'PATCH', headers: Object.assign({}, auth, { Prefer: 'return=representation' }),
          body: JSON.stringify(setCol(stage.sentCol, new Date().toISOString()))
        });
        const claimed = claim.ok ? await claim.json() : [];
        if (!claimed.length) continue;

        if (!email || email.indexOf('@') === -1) { results.push({ stage: stage.key, id: t.community_member_id, skip: 'no email' }); continue; }

        // Already a paying member? Nothing to nudge — leave it stamped.
        try {
          const ar = await fetch(URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=tier&limit=1', { headers: auth });
          const arows = ar.ok ? await ar.json() : [];
          const tier = arows[0] && String(arows[0].tier || '').toLowerCase();
          if (tier === 'full' || tier === 'forum') { results.push({ stage: stage.key, email: email, skip: 'already ' + tier }); continue; }
        } catch (e) { /* if the tier lookup fails, still send */ }

        const daysLeft = Math.max(0, Math.ceil(TRIAL_DAYS - (now - new Date(t.started_at).getTime()) / msDay));

        try {
          const sendRes = await fetch(base + '/.netlify/functions/broadcast-send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              internal_secret: SECRET, subject: stage.subject(daysLeft), preheader: stage.preheader,
              markdown: stage.markdown(daysLeft), audience: 'custom', emails: email, from: FROM
            })
          });
          const sd = await sendRes.json().catch(function () { return {}; });
          if (sendRes.ok && sd.ok) {
            results.push({ stage: stage.key, email: email, sent: sd.sent });
          } else {
            await release(URL, auth, idFilter, stage.sentCol);
            results.push({ stage: stage.key, email: email, error: sd.error || sendRes.status });
          }
        } catch (e) {
          await release(URL, auth, idFilter, stage.sentCol);
          results.push({ stage: stage.key, email: email, error: e.message });
        }
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, results: results }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

function setCol(col, val) { const o = {}; o[col] = val; return o; }
function release(URL, auth, idFilter, col) {
  return fetch(URL + '/rest/v1/note_builder_trials' + idFilter, {
    method: 'PATCH', headers: Object.assign({}, auth, { Prefer: 'return=minimal' }),
    body: JSON.stringify(setCol(col, null))
  });
}

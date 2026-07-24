// netlify/functions/referral-retention-check.js
// Daily cron. Finds referral_attributions still 'pending' whose referred member
// has (a) become a paid member, (b) is genuinely new (never on Circle), and
// (c) cleared the 15-day guarantee window and is still active. Promotes those to
// day_16_status='active' (cleared window, still paying) and emails Michael a
// single digest: "ready to pay."
//
// It does NOT mark anything paid — that stays a human action. Michael pays the
// clinician, then sets payout_status='paid' (admin UI / DB).
//
// Trigger: netlify.toml scheduled function (daily) or manual with PUBLISH_SECRET.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SES_* , NOTIFY_TO

var SESv2 = require('@aws-sdk/client-sesv2');

const GUARANTEE_DAYS = 15;   // guarantee/refund window the new member must clear
const REWARD_DOLLARS = 75;   // matches refer.js / admin payout

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const scheduled = !!(p && p.next_run);
  const secretOk = process.env.PUBLISH_SECRET && p.secret === process.env.PUBLISH_SECRET;
  if (!scheduled && !secretOk) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  const svc = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const sb = async (path, method, payload, prefer) => {
    const h = Object.assign({}, svc); if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method: method || 'GET', headers: h, body: payload ? JSON.stringify(payload) : undefined });
    const t = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + t.slice(0, 150));
    return t ? JSON.parse(t) : null;
  };

  const cutoffMs = Date.now() - GUARANTEE_DAYS * 864e5;

  try {
    const pending = await sb('referral_attributions?day_16_status=eq.pending&select=id,new_member_email,new_member_name,referrer_name,referrer_email,created_at&limit=300');
    if (!pending || !pending.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, qualified: 0 }) };

    const newlyQualified = [];
    for (const r of pending) {
      const email = String(r.new_member_email || '').toLowerCase().trim();
      if (!email) continue;
      // Never flag a payout with no real referrer to pay (belt-and-suspenders:
      // capture now only creates payable rows that resolved to a member).
      if (!r.referrer_email) continue;

      // The referred person must be a genuinely-new paid member.
      const accts = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id,tier,created_at,circle_member_id&limit=1');
      if (!accts || !accts.length) continue;
      const a = accts[0];
      if (a.tier !== 'forum' && a.tier !== 'full') continue;   // not paid (yet)
      if (a.circle_member_id != null) continue;                 // already a member pre-launch, not a new referral

      // Their live subscription must be active and past the guarantee window.
      const subs = await sb('subscriptions?account_id=eq.' + encodeURIComponent(a.id) + '&select=status,created_at,canceled_at&order=created_at.desc&limit=1');
      const s = subs && subs[0];
      if (!s || s.status !== 'active' || s.canceled_at) continue;
      const joinMs = new Date(s.created_at || a.created_at).getTime();
      if (!(joinMs <= cutoffMs)) continue;                      // still inside the guarantee window

      // Qualified: promote to 'active' (cleared the window, still paying) and
      // collect for the digest. payout_status stays 'pending' until Michael pays.
      try {
        const upd = await sb('referral_attributions?id=eq.' + r.id + '&day_16_status=eq.pending', 'PATCH', { day_16_status: 'active' }, 'return=representation');
        if (upd && upd.length) newlyQualified.push({ referrer: r.referrer_name || r.referrer_email || 'A member', referrer_email: r.referrer_email, new_member: r.new_member_name || email, new_email: email, tier: a.tier });
      } catch (e) { /* skip on race */ }
    }

    if (newlyQualified.length) {
      const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
      const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
      if (accessKeyId && secretAccessKey) {
        try {
          const region = process.env.SES_AWS_REGION || process.env.SES_REGION || 'us-east-1';
          const client = new SESv2.SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } });
          const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const rows = newlyQualified.map(function (q) {
            return '<tr><td style="padding:6px 10px;border:1px solid #ddd">' + esc(q.referrer) + (q.referrer_email ? ' &lt;' + esc(q.referrer_email) + '&gt;' : '') +
              '</td><td style="padding:6px 10px;border:1px solid #ddd">' + esc(q.new_member) + ' &lt;' + esc(q.new_email) + '&gt;</td>' +
              '<td style="padding:6px 10px;border:1px solid #ddd">' + esc(q.tier) + '</td>' +
              '<td style="padding:6px 10px;border:1px solid #ddd">$' + REWARD_DOLLARS + '</td></tr>';
          }).join('');
          await client.send(new SESv2.SendEmailCommand({
            FromEmailAddress: process.env.SES_FROM || 'Referrals <noreply@thinkbeyondpractice.com>',
            Destination: { ToAddresses: [process.env.NOTIFY_TO || 'michael@thinkbeyondpractice.com'] },
            Content: { Simple: {
              Subject: { Data: newlyQualified.length + ' referral' + (newlyQualified.length === 1 ? '' : 's') + ' ready to pay ($' + (newlyQualified.length * REWARD_DOLLARS) + ')', Charset: 'UTF-8' },
              Body: { Html: { Data:
                '<p>These referred members cleared the ' + GUARANTEE_DAYS + '-day guarantee and are still paying. Time to pay the referrer:</p>' +
                '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px"><thead><tr>' +
                '<th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Pay this referrer</th>' +
                '<th style="padding:6px 10px;border:1px solid #ddd;text-align:left">For referring</th>' +
                '<th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Tier</th>' +
                '<th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Amount</th></tr></thead><tbody>' + rows + '</tbody></table>' +
                '<p style="color:#666;font-size:13px">After you pay, mark each as paid (payout_status = paid) so it drops off this list.</p>', Charset: 'UTF-8' } }
            } }
          }));
        } catch (e) { console.log('referral digest email error:', e && e.message); }
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, checked: pending.length, qualified: newlyQualified.length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

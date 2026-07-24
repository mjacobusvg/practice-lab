// netlify/functions/referral-attribution.js
// Records "someone said someone referred them." Two capture paths feed this:
//   1) ?ref=<referrer account id> link  -> pass referrer_account_id (resolved to
//      that member's name + email here)
//   2) "Were you referred? (name)" field -> pass referrer_name (free text)
// Also still serves the standalone referral-credit.html form.
//
// Dedupes on new_member_email (one referral per new member) and ignores
// self-referrals. Rows start day_16_status='pending' / payout_status='pending';
// the referral-retention-check cron promotes them to 'qualified' once the new
// member is a paid member past the guarantee window.
//
// Body: { new_member_email, new_member_name?, referrer_name?, referrer_account_id?, notes?, source? }

var SESv2 = require('@aws-sdk/client-sesv2');

exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  const svc = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const sb = async (path, method, payload, prefer) => {
    const h = Object.assign({}, svc); if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method: method || 'GET', headers: h, body: payload ? JSON.stringify(payload) : undefined });
    const t = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + t.slice(0, 150));
    return t ? JSON.parse(t) : null;
  };

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const newEmail = String(body.new_member_email || '').trim().toLowerCase();
  const newName = body.new_member_name ? String(body.new_member_name).trim().slice(0, 120) : null;
  let referrerName = body.referrer_name ? String(body.referrer_name).trim().slice(0, 120) : null;
  let referrerEmail = null;
  const referrerAccountId = body.referrer_account_id ? String(body.referrer_account_id).trim() : null;
  const source = String(body.source || 'attribution-form').slice(0, 40);
  const notes = body.notes ? String(body.notes).trim().slice(0, 500) : null;

  if (!emailRe.test(newEmail)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
  }

  try {
    // Resolve a ?ref= account id to the referrer's name + email.
    if (referrerAccountId) {
      try {
        const acct = await sb('accounts?id=eq.' + encodeURIComponent(referrerAccountId) + '&select=name,email&limit=1');
        if (acct && acct.length) {
          // Ignore self-referral (their own link opened in their own signup).
          if (String(acct[0].email || '').toLowerCase() === newEmail) {
            return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, skipped: 'self' }) };
          }
          referrerName = referrerName || acct[0].name || 'A member';
          referrerEmail = acct[0].email || null;
        }
      } catch (e) { /* fall back to any provided name */ }
    }

    // If we don't yet have a real referrer email, try to match the typed name to
    // EXACTLY ONE real member. This is the guardrail that stops an unverifiable
    // typed name (e.g. "Ona", who is nobody) from creating a payable referral.
    // Uses a broad contains-fetch, then keeps only true name matches in JS so a
    // substring like "ona" can't spuriously match "Jonathan".
    if (!referrerEmail && referrerName) {
      try {
        const nm = referrerName.trim().toLowerCase();
        const cands = (await sb('accounts?name=ilike.*' + encodeURIComponent(referrerName.trim()) + '*&select=id,name,email&limit=25')) || [];
        const seen = {}, hits = [];
        cands.forEach(function (a) {
          const an = String(a.name || '').trim().toLowerCase();
          const first = an.split(/\s+/)[0];
          if (!seen[a.id] && (an === nm || first === nm || an.indexOf(nm + ' ') === 0)) { seen[a.id] = true; hits.push(a); }
        });
        if (hits.length === 1 && String(hits[0].email || '').toLowerCase() !== newEmail) {
          referrerName = hits[0].name; referrerEmail = hits[0].email || null;
        }
      } catch (e) { /* leave unverified */ }
    }

    if (!referrerName && !referrerEmail) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Tell us who referred you.' }) };
    }

    // A referral is only "verified" (payable, worth emailing about) once it
    // resolves to a real member account. Unmatched typed names are recorded as
    // 'unverified' and never enter the payout pipeline or trigger an email.
    const verified = !!referrerEmail;

    // Dedupe: one referral per new member (first one wins).
    const existing = await sb('referral_attributions?new_member_email=eq.' + encodeURIComponent(newEmail) + '&select=id&limit=1');
    if (existing && existing.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, already: true }) };
    }

    await sb('referral_attributions', 'POST', {
      new_member_email: newEmail,
      new_member_name: newName,
      referrer_name: referrerName,
      referrer_email: referrerEmail,
      notes: notes,
      source: source,
      day_16_status: verified ? 'pending' : 'unverified',
      payout_status: 'pending'
    }, 'return=minimal');

    // Notify Michael ONLY for verified referrals (resolved to a real member) —
    // no more "captured" emails for unverifiable typed names like "Ona".
    const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
    const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
    if (verified && accessKeyId && secretAccessKey) {
      try {
        const region = process.env.SES_AWS_REGION || process.env.SES_REGION || 'us-east-1';
        const client = new SESv2.SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } });
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await client.send(new SESv2.SendEmailCommand({
          FromEmailAddress: process.env.SES_FROM || 'Referral Attribution <noreply@thinkbeyondpractice.com>',
          Destination: { ToAddresses: [process.env.NOTIFY_TO || 'michael@thinkbeyondpractice.com'] },
          Content: { Simple: {
            Subject: { Data: 'New referral captured: ' + (referrerName || referrerEmail || 'a member'), Charset: 'UTF-8' },
            Body: { Html: { Data:
              '<p>A new referral was recorded (pending the guarantee window):</p><ul>' +
              '<li><strong>New member:</strong> ' + esc(newName || '') + ' &lt;' + esc(newEmail) + '&gt;</li>' +
              '<li><strong>Referred by:</strong> ' + esc(referrerName || '') + (referrerEmail ? ' &lt;' + esc(referrerEmail) + '&gt;' : '') + '</li>' +
              '<li><strong>Source:</strong> ' + esc(source) + '</li></ul>' +
              '<p>You will get a separate "ready to pay" email once they pass the guarantee window and are still a paid member.</p>', Charset: 'UTF-8' } }
          } }
        }));
      } catch (e) { /* non-blocking */ }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, success: true }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not save your submission. Please try again.' }) };
  }
};

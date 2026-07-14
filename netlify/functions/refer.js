// netlify/functions/refer.js
// Member-facing referral: invite a colleague by email (records the referral and
// emails them a personal invite) and list your own referrals + statuses. Payouts
// are managed by Michael in the existing admin flow ($ per referral after the
// day-16 retention gate). Writes with the service key; the member is identified
// by their signed token.
//
// Actions:
//   { token, action:'invite', to_email, to_name?, note? }
//   { token, action:'list' }   -> { reward_dollars, referrals:[...] }

const { verifyToken } = require('./_lib/session');
const { emailBcc } = require('./_lib/notify');

const REWARD_DOLLARS = 75; // matches admin-dashboard REFERRAL_PAYOUT
const PLATFORM_URL = 'https://thinkbeyondpractice.com/platform.html';

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

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
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const sb = async (path, method, body, prefer) => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, auth);
    if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 150));
    return text ? JSON.parse(text) : null;
  };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid || session.claims.scope !== 'member') return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Members only' }) };
  const email = String(session.claims.email || '').toLowerCase().trim();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  try {
    const meRows = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id,name&limit=1', 'GET');
    const me = meRows && meRows[0];
    if (!me) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found.' }) };
    const myName = me.name || 'A colleague';

    if (p.action === 'list') {
      const refs = await sb('referral_attributions?referrer_email=eq.' + encodeURIComponent(email) + '&order=created_at.desc&select=new_member_email,new_member_name,day_16_status,payout_status,created_at', 'GET');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reward_dollars: REWARD_DOLLARS, referral_link: PLATFORM_URL + '?ref=' + me.id, referrals: refs || [] }) };
    }

    if (p.action === 'invite') {
      const toEmail = String(p.to_email || '').trim().toLowerCase();
      const toName = String(p.to_name || '').trim().slice(0, 120) || null;
      const note = String(p.note || '').trim().slice(0, 500) || null;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Enter a valid email.' }) };
      if (toEmail === email) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "That's your own email." }) };

      // Already a member? Then there's nothing to refer.
      const existingAcct = await sb('accounts?email=eq.' + encodeURIComponent(toEmail) + '&select=id&limit=1', 'GET');
      if (existingAcct && existingAcct.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'That person is already on the platform.' }) };

      // Don't double-log the same invite from the same referrer.
      const dupe = await sb('referral_attributions?referrer_email=eq.' + encodeURIComponent(email) + '&new_member_email=eq.' + encodeURIComponent(toEmail) + '&select=id&limit=1', 'GET');
      if (!dupe || !dupe.length) {
        await sb('referral_attributions', 'POST', {
          new_member_email: toEmail, new_member_name: toName,
          referrer_name: myName, referrer_email: email,
          notes: note, source: 'in-app-invite', day_16_status: 'pending', payout_status: 'pending'
        }, 'return=minimal');
      }

      // Email the colleague a personal invite (best-effort).
      try {
        const html = '<p><strong>' + esc(myName) + '</strong> invited you to <strong>Think Beyond Practice</strong>, a community and toolkit for psychiatric prescribers.</p>' +
          (note ? '<blockquote>' + esc(note) + '</blockquote>' : '') +
          '<p>It has a peer community, an "Ask the Archive" answer engine drawn from hundreds of prescriber posts, billing/documentation tools, a template library, and more.</p>' +
          '<p><a href="' + PLATFORM_URL + '?ref=' + me.id + '" style="display:inline-block;background:#0b7285;color:#fff;padding:11px 18px;border-radius:6px;text-decoration:none">Take a look &rarr;</a></p>';
        await emailBcc([toEmail], myName + ' invited you to Think Beyond Practice', html);
      } catch (e) { /* invite still recorded */ }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

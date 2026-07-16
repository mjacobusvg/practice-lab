// netlify/functions/broadcast-send.js
// Admin-only email broadcast to the community roster (public.contacts). This is
// the "send my weekly email to members / to non-members" tool that replaces
// Circle broadcasts.
//
// Body: {
//   token, subject,
//   markdown?  |  html?,     // body: markdown is converted server-side; html used as-is
//   audience,                // all | members | nonmembers | free | forum | full
//   test_email?,             // if set: send ONLY to this address (preview), logged as status 'test'
//   dry_run?                 // resolve recipients + count, send nothing
// }
// -> { ok, audience, recipients, sent, dry_run, test }
//
// Each message is sent per-recipient (so the footer carries that person's own
// one-click unsubscribe link) and personalizes {{first_name}} / {{name}}.
// Disposable/test addresses are always excluded. subscribed=false is excluded.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SES_* / AWS_*, SESSION_SIGNING_SECRET

const { verifyToken } = require('./_lib/session');
const { toRichHtml, esc } = require('./_lib/richtext');
const { mintPrefsToken } = require('./_lib/prefs-token');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];
const SITE = 'https://thinkbeyondpractice.com';

function isDisposable(e) { return /@slmails\.com$/i.test(e) || /\+test/i.test(e); }

function audienceFilter(a) {
  switch (String(a || '').toLowerCase()) {
    case 'members': return 'tier=in.(forum,full)';
    case 'nonmembers': return 'tier=eq.free';
    case 'free': return 'tier=eq.free';
    case 'forum': return 'tier=eq.forum';
    case 'full': return 'tier=eq.full';
    case 'all': return '';
    default: return null;
  }
}

function sesClient() {
  const accessKeyId = process.env.SES_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  const region = process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
  const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
  return {
    client: new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } }),
    SendEmailCommand: SendEmailCommand,
    from: process.env.SES_FROM || 'Think Beyond Practice <noreply@thinkbeyondpractice.com>'
  };
}

// Personalize a merge field for one recipient.
function personalize(html, contact) {
  const first = (contact.first_name || (contact.name || '').split(' ')[0] || 'there').trim();
  const name = (contact.name || first).trim();
  return html.replace(/\{\{\s*first_name\s*\}\}/gi, esc(first)).replace(/\{\{\s*name\s*\}\}/gi, esc(name));
}

// One-click broadcast unsubscribe (flips contacts.subscribed=false) + platform link.
function footer(email) {
  var unsub = SITE + '/.netlify/functions/broadcast-unsub?t=' + encodeURIComponent(mintPrefsToken(email));
  return '<div style="font-size:12px;color:#8a8a8a;margin-top:28px;border-top:1px solid #eee;padding-top:14px;line-height:1.5">' +
    'Think Beyond Practice LLC, 9631 N Nevada St Suite 209, Spokane WA 99218<br>' +
    'You are receiving this because you are on the Think Beyond Practice list. ' +
    '<a href="' + unsub + '" style="color:#8a8a8a">Unsubscribe</a>.' +
    '</div>';
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  const adminEmail = String(session.claims && session.claims.email || '').toLowerCase();
  if (!session.valid || ADMIN_EMAILS.indexOf(adminEmail) === -1) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };
  }

  const subject = String(p.subject || '').trim();
  if (!subject) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Subject required' }) };
  const bodyHtml = (p.html != null && String(p.html).trim())
    ? String(p.html)
    : toRichHtml(String(p.markdown || ''));
  if (!bodyHtml.trim()) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Body required' }) };

  const filter = audienceFilter(p.audience);
  if (filter === null) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad audience' }) };

  const wrap = function (inner) {
    return '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a2430;font-size:15px;line-height:1.6">' +
      inner + '</div>';
  };

  try {
    // Resolve recipients.
    let recipients;
    if (p.test_email) {
      const te = String(p.test_email).toLowerCase().trim();
      recipients = [{ email: te, name: 'Preview', first_name: 'Preview' }];
    } else {
      const qs = ['select=email,name,first_name', 'subscribed=eq.true', 'limit=10000'];
      if (filter) qs.push(filter);
      const res = await fetch(URL + '/rest/v1/contacts?' + qs.join('&'), { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
      const rows = res.ok ? await res.json() : [];
      recipients = (rows || []).filter(function (r) { return r.email && r.email.indexOf('@') !== -1 && !isDisposable(r.email); });
    }

    if (p.dry_run) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, dry_run: true, audience: p.audience, recipients: recipients.length, sent: 0, test: !!p.test_email }) };
    }
    if (!recipients.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'No recipients for that audience' }) };

    const ses = sesClient();
    if (!ses) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Email transport not configured' }) };

    let sent = 0;
    const CONC = 5;
    for (let i = 0; i < recipients.length; i += CONC) {
      const batch = recipients.slice(i, i + CONC);
      await Promise.all(batch.map(function (c) {
        const html = wrap(personalize(bodyHtml, c) + footer(c.email));
        return ses.client.send(new ses.SendEmailCommand({
          FromEmailAddress: ses.from,
          Destination: { ToAddresses: [c.email] },
          Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } }
        })).then(function () { sent++; }).catch(function (e) { console.log('broadcast send error for one recipient:', e && e.message); });
      }));
    }

    // Log the broadcast (best-effort).
    try {
      await fetch(URL + '/rest/v1/broadcasts', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, auth),
        body: JSON.stringify({ subject: subject, audience: String(p.audience || 'all'), recipient_count: sent, sent_by: adminEmail, status: p.test_email ? 'test' : 'sent' })
      });
    } catch (e) { /* logging is best-effort */ }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, dry_run: false, audience: p.audience, recipients: recipients.length, sent: sent, test: !!p.test_email }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

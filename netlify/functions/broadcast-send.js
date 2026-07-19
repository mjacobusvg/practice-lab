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
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  const region = process.env.SES_AWS_REGION || process.env.SES_REGION || 'us-east-1';
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

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Open-tracking pixel for one recipient of one broadcast.
function pixelTag(bid, token) {
  var src = SITE + '/.netlify/functions/broadcast-track?b=' + encodeURIComponent(bid) + '&e=' + encodeURIComponent(token) + '&k=open';
  return '<img src="' + src + '" width="1" height="1" alt="" style="display:none">';
}
// Rewrite every http(s) link in the body to route through the click tracker.
function trackLinks(html, bid, token) {
  return String(html).replace(/href="(https?:\/\/[^"]+)"/gi, function (m, url) {
    var redirect = SITE + '/.netlify/functions/broadcast-track?b=' + encodeURIComponent(bid) + '&e=' + encodeURIComponent(token) + '&k=click&u=' + encodeURIComponent(b64url(url));
    return 'href="' + redirect + '"';
  });
}
// One-click broadcast unsubscribe (flips contacts.subscribed=false) + platform link.
function footer(email, bid) {
  var unsub = SITE + '/.netlify/functions/broadcast-unsub?t=' + encodeURIComponent(mintPrefsToken(email)) + (bid ? '&b=' + encodeURIComponent(bid) : '');
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
      // Resolve the tester's real name so the preview shows the actual greeting
      // ({{first_name}}) instead of a placeholder.
      let fn = '', nm = '';
      try {
        const cr = await fetch(URL + '/rest/v1/contacts?email=eq.' + encodeURIComponent(te) + '&select=first_name,name&limit=1', { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
        const crows = cr.ok ? await cr.json() : [];
        if (crows[0]) { fn = crows[0].first_name || ''; nm = crows[0].name || ''; }
        if (!fn && !nm) {
          const ar = await fetch(URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(te) + '&select=name&limit=1', { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
          const arows = ar.ok ? await ar.json() : [];
          if (arows[0]) nm = arows[0].name || '';
        }
      } catch (e) { /* fall back to a neutral greeting */ }
      const first = fn || (nm.split(' ')[0]) || 'there';
      recipients = [{ email: te, name: nm || first, first_name: first }];
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

    // Create the broadcast row FIRST (real sends only) so every email can carry
    // its broadcast id for open/click tracking. Test sends are not tracked.
    let bid = null;
    if (!p.test_email) {
      try {
        const ins = await fetch(URL + '/rest/v1/broadcasts', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=representation' }, auth),
          body: JSON.stringify({ subject: subject, audience: String(p.audience || 'all'), recipient_count: 0, sent_by: adminEmail, status: 'sent' })
        });
        const insRows = ins.ok ? await ins.json() : [];
        bid = (insRows && insRows[0] && insRows[0].id) ? insRows[0].id : null;
      } catch (e) { /* tracking row best-effort */ }
    }

    let sent = 0;
    const sendErrors = [];
    const CONC = 5;
    for (let i = 0; i < recipients.length; i += CONC) {
      const batch = recipients.slice(i, i + CONC);
      await Promise.all(batch.map(function (c) {
        const token = mintPrefsToken(c.email);
        let inner = personalize(bodyHtml, c);
        // Click tracking (exact) + unsubscribe attribution only. No open pixel:
        // open tracking is unreliable (mail apps pre-fetch or block it) and adds
        // little over clicks + actual signups.
        if (bid) inner = trackLinks(inner, bid, token);
        let html = wrap(inner + footer(c.email, bid));
        return ses.client.send(new ses.SendEmailCommand({
          FromEmailAddress: ses.from,
          Destination: { ToAddresses: [c.email] },
          Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } }
        })).then(function () { sent++; }).catch(function (e) { sendErrors.push((e && e.message) || 'send failed'); console.log('broadcast send error for one recipient:', e && e.message); });
      }));
    }

    // If nothing actually sent, tell the truth instead of a false "sent" — the
    // most common cause is AWS SES sandbox mode (recipient not verified) or an
    // unverified From identity.
    if (sent === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'No emails were sent — ' + (sendErrors[0] || 'the email service rejected the send.'), sent: 0, recipients: recipients.length, test: !!p.test_email }) };
    }

    // Finalize the recipient count now that we know how many actually sent.
    if (bid) {
      try {
        await fetch(URL + '/rest/v1/broadcasts?id=eq.' + encodeURIComponent(bid), {
          method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, auth),
          body: JSON.stringify({ recipient_count: sent })
        });
      } catch (e) { /* best-effort */ }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, dry_run: false, audience: p.audience, recipients: recipients.length, sent: sent, test: !!p.test_email, broadcast_id: bid }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

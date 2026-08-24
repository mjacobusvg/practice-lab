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
const { mintSigninToken } = require('./_lib/signin-token');

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

// Usage-based audiences: resolved from public.tool_usage (who actually USED a tool),
// NOT from membership tier. This lets a broadcast reach exactly the people using a tool
// — e.g. everyone currently drafting in the AI Scribe, trial users included, regardless
// of tier — instead of every full member whether they touch the tool or not. The value
// is the exact tool_usage.tool label the tool logs (see _lib/usage.js / clinical-proxy-stream).
const USAGE_AUDIENCES = { scribe: 'AI Scribe' };
function usageToolFor(a) { return USAGE_AUDIENCES[String(a || '').toLowerCase()] || null; }

function sesClient() {
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  const region = process.env.SES_AWS_REGION || process.env.SES_REGION || 'us-east-1';
  const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
  return {
    client: new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } }),
    SendEmailCommand: SendEmailCommand,
    from: process.env.SES_FROM || 'Think Beyond Practice <noreply@thinkbeyondpractice.com>',
    // Where replies land. The From identity is a noreply on the sending domain,
    // so without this every reply to a broadcast is lost. Defaults to the monitored
    // admin mailbox on the sending domain; per-broadcast override via p.reply_to.
    replyTo: process.env.SES_REPLY_TO || 'michael@thinkbeyondpractice.com'
  };
}

// Personalize a merge field for one recipient. Two one-click sign-in tags:
//   {{signin_link}}  — the FULL one-click URL (use in raw-HTML bodies).
//   {{signin_token}} — just the signed token (use inside a Markdown link, e.g.
//                      [Open →](https://thinkbeyondpractice.com/.netlify/functions/one-click-signin?t={{signin_token}}),
//                      because the Markdown link renderer only accepts an http(s) URL at
//                      conversion time — {{signin_link}} alone would render as dead text.
// Either way the member lands on /platform already logged in (no inbox round-trip).
// Falls back to the plain platform URL / empty token if one can't be minted.
function personalize(html, contact) {
  const first = (contact.first_name || (contact.name || '').split(' ')[0] || 'there').trim();
  const name = (contact.name || first).trim();
  let token = '', signin = SITE + '/platform';
  try {
    if (contact.email) { token = mintSigninToken(contact.email); signin = SITE + '/.netlify/functions/one-click-signin?t=' + token; }
  } catch (e) { /* fall back to the plain platform link */ }
  return html
    .replace(/\{\{\s*first_name\s*\}\}/gi, esc(first))
    .replace(/\{\{\s*name\s*\}\}/gi, esc(name))
    .replace(/\{\{\s*signin_link\s*\}\}/gi, signin)
    .replace(/\{\{\s*signin_token\s*\}\}/gi, token);
}

// A member clicking a plain /platform link in an email hits the cold magic-link gate
// ("enter your email → check inbox → click → come back"), and that round-trip is where
// dormant members bounce. So rewrite member-GATED links to route through one-click-signin
// with this recipient's token: they land ALREADY signed in on the intended page. Public
// and marketing pages, signup routes (?join, /start-scribe), and links already routed
// through one-click-signin are left untouched (wrapping a public page would force a
// pointless login). Runs per-recipient, before link tracking, so clicks still count.
function needsAuth(path) {
  if (/^\/start-scribe/i.test(path)) return false;    // signup entry (logged-out)
  if (/[?&]join(&|=|$)/i.test(path)) return false;    // signup deep link
  if (/[?&]demo=1(&|$)/i.test(path)) return false;    // public demo, no login needed
  return /^\/platform(\.html)?([\/?#]|$)/i.test(path)
      || /^\/pm-/i.test(path)
      || /^\/ai-scribe-workspace\.html/i.test(path)
      || /^\/eps-quick-reference/i.test(path);
}
function oneClickify(html, contact) {
  var email = contact && contact.email;
  if (!email) return html;
  var token;
  try { token = mintSigninToken(email); } catch (e) { return html; }
  return String(html).replace(/href="(https?:\/\/thinkbeyondpractice\.com(\/[^"]*)?)"/gi, function (m, full, path) {
    if (/one-click-signin/i.test(full)) return m;   // already a one-click link
    path = path || '/';
    if (!needsAuth(path)) return m;
    return 'href="' + SITE + '/.netlify/functions/one-click-signin?t=' + token + '&r=' + encodeURIComponent(path) + '"';
  });
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
// The one-click unsubscribe URL for one recipient (used both in the visible
// footer link and in the RFC 8058 List-Unsubscribe header).
function unsubUrl(email, bid) {
  return SITE + '/.netlify/functions/broadcast-unsub?t=' + encodeURIComponent(mintPrefsToken(email)) + (bid ? '&b=' + encodeURIComponent(bid) : '');
}

// RFC 2047 encoded-word for a header value that may contain non-ASCII (e.g. the
// subject). ASCII passes through untouched.
function encodeHeaderWord(s) {
  s = String(s);
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

// Build a raw MIME message so we can attach the List-Unsubscribe /
// List-Unsubscribe-Post headers (SES Content.Simple does not allow custom
// headers). One-click unsubscribe (RFC 8058) is what Gmail/Yahoo want to show
// the native "Unsubscribe" affordance and is now required for bulk senders.
function buildRawEmail(opts) {
  var CRLF = '\r\n';
  var bodyB64 = Buffer.from(String(opts.html), 'utf8').toString('base64').replace(/(.{76})/g, '$1' + CRLF);
  var lines = [
    'From: ' + opts.from,
    'Reply-To: ' + (opts.replyTo || opts.from),
    'To: ' + opts.to,
    'Subject: ' + encodeHeaderWord(opts.subject),
    'MIME-Version: 1.0',
    'List-Unsubscribe: <' + opts.unsub + '>',
    'List-Unsubscribe-Post: List=One-Click',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyB64
  ];
  return Buffer.from(lines.join(CRLF), 'utf8');
}

// One-click broadcast unsubscribe (flips contacts.subscribed=false) + platform link.
function footer(email, bid) {
  var unsub = unsubUrl(email, bid);
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
  const isAdmin = session.valid && ADMIN_EMAILS.indexOf(adminEmail) !== -1;
  // The scheduled-broadcast cron calls this endpoint to send a queued broadcast.
  const internalOk = p.internal_secret && p.internal_secret === process.env.BACKFILL_SECRET;
  if (!isAdmin && !internalOk) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };
  }

  // Manage the scheduled-broadcast queue (admin UI).
  if (p.action === 'list_scheduled') {
    const r = await fetch(URL + '/rest/v1/scheduled_broadcasts?status=eq.scheduled&order=scheduled_at.asc&select=id,subject,audience,scheduled_at', { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, scheduled: r.ok ? await r.json() : [] }) };
  }
  if (p.action === 'cancel_scheduled' && p.id) {
    await fetch(URL + '/rest/v1/scheduled_broadcasts?id=eq.' + encodeURIComponent(p.id), { method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, auth), body: JSON.stringify({ status: 'canceled' }) });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, canceled: true }) };
  }

  const subject = String(p.subject || '').trim();
  if (!subject) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Subject required' }) };
  const bodyHtml = (p.html != null && String(p.html).trim())
    ? String(p.html)
    : toRichHtml(String(p.markdown || ''));
  if (!bodyHtml.trim()) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Body required' }) };

  // Optional preheader: the inbox preview text shown next to the subject. Rendered
  // as a hidden block at the very top of the email so it, not the greeting, is what
  // the inbox previews. Trailing zero-width spacer pushes the visible body out of
  // the preview so it doesn't bleed in after the preheader.
  const preheader = String(p.preheader || '').trim().slice(0, 200);

  const isCustom = String(p.audience || '').toLowerCase() === 'custom';
  const usageTool = usageToolFor(p.audience);
  const filter = audienceFilter(p.audience);
  if (filter === null && !isCustom && !usageTool) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad audience' }) };

  // Schedule for later instead of sending now (admin UI; real sends only, never a
  // test). The send-scheduled-broadcasts cron sends it when its time comes.
  if (p.scheduled_at && !p.test_email) {
    const when = new Date(p.scheduled_at);
    if (isNaN(when.getTime()) || when.getTime() < Date.now() - 60000) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Pick a future date and time.' }) };
    }
    const ins = await fetch(URL + '/rest/v1/scheduled_broadcasts', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=representation' }, auth),
      body: JSON.stringify({ subject: subject, markdown: String(p.markdown || ''), preheader: preheader, audience: String(p.audience || 'all'), emails: String(p.emails || ''), scheduled_at: when.toISOString(), sent_by: adminEmail || 'admin', status: 'scheduled' })
    });
    if (!ins.ok) { const t = await ins.text(); return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Could not schedule: ' + t.slice(0, 150) }) }; }
    const rows = await ins.json();
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, scheduled: true, scheduled_at: when.toISOString(), id: rows[0] && rows[0].id }) };
  }

  const wrap = function (inner) {
    return '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a2430;font-size:15px;line-height:1.6">' +
      inner + '</div>';
  };
  const preheaderBlock = function () {
    if (!preheader) return '';
    const spacer = '&#847;&zwnj;&nbsp;'.repeat(60); // zero-width filler so the body doesn't bleed into the preview
    return '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#f4f7fb;opacity:0">' + esc(preheader) + spacer + '</div>';
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
    } else if (isCustom) {
      // Hand-picked recipients: exactly the addresses the admin typed. Personalize
      // from contacts where we know them; send anyway if we don't. (Global opt-outs
      // still respected below via the shared filters — disposable excluded.)
      const list = String(p.emails || '').split(/[\s,;]+/).map(function (e) { return e.toLowerCase().trim(); })
        .filter(function (e) { return e.indexOf('@') !== -1 && !isDisposable(e); });
      const uniq = Array.from(new Set(list));
      const byEmail = {};
      if (uniq.length) {
        const inList = uniq.map(function (e) { return '"' + e.replace(/"/g, '') + '"'; }).join(',');
        const cr = await fetch(URL + '/rest/v1/contacts?email=in.(' + encodeURIComponent(inList) + ')&select=email,name,first_name', { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
        const crows = cr.ok ? await cr.json() : [];
        crows.forEach(function (r) { byEmail[String(r.email).toLowerCase()] = r; });
      }
      recipients = uniq.map(function (e) { const c = byEmail[e] || {}; return { email: e, name: c.name || '', first_name: c.first_name || '' }; });
    } else if (usageTool) {
      // Everyone who actually USED this tool (drafted with it) within the window, from
      // public.tool_usage, then intersected with SUBSCRIBED contacts so opt-outs are
      // respected and we have a name to personalize. Tier-agnostic on purpose: a trial
      // user drafting in the Scribe is exactly who a Scribe-change note must reach, even
      // though their tier is free/forum. Default window 90 days; override with used_since_days.
      const days = Math.max(1, Math.min(3650, Number(p.used_since_days) || 90));
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const ur = await fetch(URL + '/rest/v1/tool_usage?tool=eq.' + encodeURIComponent(usageTool) + '&created_at=gte.' + encodeURIComponent(since) + '&account_email=not.is.null&select=account_email&limit=100000', { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
      const urows = ur.ok ? await ur.json() : [];
      const usedEmails = Array.from(new Set(urows.map(function (r) { return String(r.account_email || '').toLowerCase().trim(); })
        .filter(function (e) { return e.indexOf('@') !== -1 && !isDisposable(e); })));
      // Active users may live in accounts (real signed-in users) but not on the marketing
      // contacts list. Include them anyway — they're exactly who a tool-change note must reach —
      // pulling a name from contacts first, then accounts. Only EXPLICIT opt-outs
      // (contacts.subscribed=false) are dropped; a user with no contacts row hasn't opted out.
      const contactByEmail = {}, acctByEmail = {};
      for (let start = 0; start < usedEmails.length; start += 400) {
        const chunk = usedEmails.slice(start, start + 400);
        const inList = chunk.map(function (e) { return '"' + e.replace(/"/g, '') + '"'; }).join(',');
        const cr = await fetch(URL + '/rest/v1/contacts?email=in.(' + encodeURIComponent(inList) + ')&select=email,name,first_name,subscribed', { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
        (cr.ok ? await cr.json() : []).forEach(function (r) { contactByEmail[String(r.email).toLowerCase()] = r; });
        const ar = await fetch(URL + '/rest/v1/accounts?email=in.(' + encodeURIComponent(inList) + ')&select=email,name', { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
        (ar.ok ? await ar.json() : []).forEach(function (r) { acctByEmail[String(r.email).toLowerCase()] = r; });
      }
      recipients = usedEmails
        .filter(function (e) { const c = contactByEmail[e]; return !(c && c.subscribed === false); })
        .map(function (e) {
          const c = contactByEmail[e] || {}, a = acctByEmail[e] || {};
          const name = c.name || a.name || '';
          const first = c.first_name || (name.split(' ')[0]) || '';
          return { email: e, name: name, first_name: first };
        });
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

    // Per-broadcast sender identity. A personal 1:1-style nudge should come from a
    // human address with replies that reach a real mailbox, not the noreply brand
    // identity used for routine list mail. Overridable per send (admin-gated above);
    // the From address must be a verified SES identity (any @thinkbeyondpractice.com
    // address is covered by domain verification).
    const fromAddr = (p.from && String(p.from).trim()) || ses.from;
    const replyToAddr = (p.reply_to && String(p.reply_to).trim()) || ses.replyTo;

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
        // Land member-gated clicks already signed in, instead of at the cold login gate.
        inner = oneClickify(inner, c);
        // Click tracking (exact) + open-tracking pixel. NOTE: open rates are
        // directional only — Apple Mail Privacy pre-fetches images (inflates) and
        // image-blockers suppress them (deflates). Clicks remain the truer signal.
        if (bid) { inner = trackLinks(inner, bid, token); inner = inner + pixelTag(bid, token); }
        let html = wrap(preheaderBlock() + inner + footer(c.email, bid));
        const raw = buildRawEmail({ from: fromAddr, replyTo: replyToAddr, to: c.email, subject: subject, html: html, unsub: unsubUrl(c.email, bid) });
        return ses.client.send(new ses.SendEmailCommand({
          FromEmailAddress: fromAddr,
          Destination: { ToAddresses: [c.email] },
          Content: { Raw: { Data: raw } }
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

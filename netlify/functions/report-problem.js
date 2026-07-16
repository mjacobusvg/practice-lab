// netlify/functions/report-problem.js
// The member-facing "Report a problem" support channel. Records the report and
// emails the admin so nothing gets lost. Identity + tier come from the signed
// session token when present (we never trust a client-supplied email); logged-out
// visitors may still report and optionally leave a reply address in the message.
//
// Body: { message, page?, ua?, token? }
// -> { ok }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SES_* / AWS_*, SUPPORT_TO/SES_FROM

const { verifyToken } = require('./_lib/session');

const SUPPORT_TO = process.env.SUPPORT_TO || 'support@thinkbeyondpractice.com';

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function clip(v, n) { return v == null ? null : String(v).slice(0, n); }

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

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const message = clip(p.message, 4000);
  if (!message || !message.trim()) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Please describe the problem.' }) };

  let email = null, tier = null;
  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    if (token) { const s = verifyToken(token); if (s.valid) { email = String(s.claims.email || '').toLowerCase() || null; tier = s.claims.tier || null; } }
  } catch (e) { /* anon allowed */ }

  const page = clip(p.page, 300);
  const ua = clip(p.ua || event.headers['user-agent'], 400);

  // Log the report (best-effort).
  if (URL && KEY) {
    try {
      await fetch(URL + '/rest/v1/problem_reports', {
        method: 'POST',
        headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ email: email, tier: tier, page: page, message: message, user_agent: ua })
      });
    } catch (e) { /* best-effort */ }
  }

  // Email the admin (best-effort).
  try {
    const accessKeyId = process.env.SES_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    if (accessKeyId && secretAccessKey) {
      const region = process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
      const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
      const client = new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } });
      const from = process.env.SES_FROM || 'Think Beyond Practice <noreply@thinkbeyondpractice.com>';
      const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a2430">' +
        '<p style="font-size:16px"><strong>New problem report</strong></p>' +
        '<p><strong>From:</strong> ' + esc(email || 'not signed in') + (tier ? ' (' + esc(tier) + ')' : '') + '<br>' +
        '<strong>Page:</strong> ' + esc(page || 'unknown') + '</p>' +
        '<p style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:12px">' + esc(message) + '</p>' +
        '<p style="font-size:12px;color:#888">' + esc(ua || '') + '</p></div>';
      const dest = { ToAddresses: [SUPPORT_TO] };
      const cmd = { FromEmailAddress: from, Destination: dest, Content: { Simple: { Subject: { Data: 'Problem report' + (email ? ' from ' + email : ''), Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } } };
      if (email && email.indexOf('@') !== -1) cmd.ReplyToAddresses = [email];
      await client.send(new SendEmailCommand(cmd));
    }
  } catch (e) { console.log('report-problem email error:', e && e.message); }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};

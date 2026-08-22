// netlify/functions/_lib/marketplace-notify.js
//
// SES email + ICS calendar invites for marketplace bookings. Uses the same AWS
// SES v2 setup as the rest of the app (SES_* env). Best-effort: callers should
// never fail a webhook/checkout because an email bounced.

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

const FROM = 'Think Beyond Practice <support@thinkbeyondpractice.com>';

function sesClient() {
  const region = process.env.SES_AWS_REGION || process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  const cfg = { region: region };
  if (accessKeyId && secretAccessKey) cfg.credentials = { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey };
  return new SESv2Client(cfg);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// Format an ISO instant in a given IANA timezone, e.g. "Tue, Sep 9, 2026, 2:00 PM EDT".
function fmt(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    }).format(new Date(iso));
  } catch (e) {
    return new Date(iso).toUTCString();
  }
}

// ICS UTC stamp: 20260909T180000Z
function icsStamp(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function buildIcs(opts) {
  // opts: { uid, start, end, summary, description, organizerEmail, attendeeEmail, location }
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Think Beyond Practice//Marketplace//EN',
    'CALSCALE:GREGORIAN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    'UID:' + opts.uid,
    'DTSTAMP:' + icsStamp(new Date().toISOString()),
    'DTSTART:' + icsStamp(opts.start),
    'DTEND:' + icsStamp(opts.end),
    'SUMMARY:' + icsText(opts.summary),
    'DESCRIPTION:' + icsText(opts.description || ''),
    opts.location ? 'LOCATION:' + icsText(opts.location) : null,
    opts.organizerEmail ? 'ORGANIZER;CN=Think Beyond Practice:mailto:' + opts.organizerEmail : null,
    opts.attendeeEmail ? 'ATTENDEE;CN=' + icsText(opts.attendeeEmail) + ';RSVP=TRUE:mailto:' + opts.attendeeEmail : null,
    'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean);
  return lines.join('\r\n');
}
function icsText(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Build a raw multipart/mixed MIME message with an HTML body + a text/calendar
// attachment, so the recipient can add the session to their calendar.
function buildRawEmail(opts) {
  // opts: { from, to, subject, html, text, ics }
  const boundary = 'tbpmp_' + icsStamp(new Date().toISOString()) + '_b';
  const parts = [];
  parts.push('From: ' + opts.from);
  parts.push('To: ' + opts.to);
  parts.push('Subject: ' + opts.subject);
  parts.push('MIME-Version: 1.0');
  parts.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  parts.push('');
  parts.push('--' + boundary);
  parts.push('Content-Type: text/html; charset=UTF-8');
  parts.push('Content-Transfer-Encoding: 7bit');
  parts.push('');
  parts.push(opts.html);
  parts.push('');
  if (opts.ics) {
    parts.push('--' + boundary);
    parts.push('Content-Type: text/calendar; method=REQUEST; charset=UTF-8; name="session.ics"');
    parts.push('Content-Transfer-Encoding: base64');
    parts.push('Content-Disposition: attachment; filename="session.ics"');
    parts.push('');
    parts.push(Buffer.from(opts.ics, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'));
    parts.push('');
  }
  parts.push('--' + boundary + '--');
  parts.push('');
  return parts.join('\r\n');
}

async function sendRaw(opts) {
  const raw = buildRawEmail(opts);
  await sesClient().send(new SendEmailCommand({
    Content: { Raw: { Data: Buffer.from(raw, 'utf8') } }
  }));
}

// Confirmation to the BUYER, with ICS. data: { toEmail, sellerName, startIso, endIso,
//   buyerTz, meetingUrl, kind, toolkitIncluded, signInUrl }
async function sendBuyerConfirmation(data) {
  const when = fmt(data.startIso, data.buyerTz);
  const ics = buildIcs({
    uid: 'mp-' + (data.bookingId || icsStamp(data.startIso)) + '@thinkbeyondpractice.com',
    start: data.startIso, end: data.endIso,
    summary: 'Mentoring with ' + (data.sellerName || 'your mentor'),
    description: (data.meetingUrl ? ('Join: ' + data.meetingUrl + '\\n\\n') : '') +
      'Booked through Think Beyond Practice.',
    organizerEmail: 'support@thinkbeyondpractice.com',
    attendeeEmail: data.toEmail,
    location: data.meetingUrl || 'Online'
  });
  const toolkitBlock = data.toolkitIncluded
    ? '<p style="font-size:15px;line-height:1.6">Your purchase includes the <strong>Private Practice Toolkit</strong>. ' +
      (data.signInUrl ? 'Sign in to download it: <a href="' + esc(data.signInUrl) + '">access your toolkit</a>.' : 'Sign in to your account to download it.') + '</p>'
    : '';
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:540px;color:#1a2430">' +
    '<h2 style="font-size:20px;margin:0 0 10px">You\u2019re booked with ' + esc(data.sellerName || 'your mentor') + '</h2>' +
    '<p style="font-size:15px;line-height:1.6"><strong>' + esc(when) + '</strong></p>' +
    (data.meetingUrl ? '<p style="font-size:15px;line-height:1.6">Join link: <a href="' + esc(data.meetingUrl) + '">' + esc(data.meetingUrl) + '</a></p>' : '<p style="font-size:14px;color:#5a6672">Your mentor will share the meeting link before your session.</p>') +
    toolkitBlock +
    '<p style="font-size:13px;color:#8a94a0">A calendar invite is attached. Think Beyond Practice.</p></div>';
  const text = 'You\u2019re booked with ' + (data.sellerName || 'your mentor') + '\n' + when +
    (data.meetingUrl ? ('\nJoin: ' + data.meetingUrl) : '') +
    (data.toolkitIncluded ? '\n\nYour purchase includes the Private Practice Toolkit; sign in to download it.' : '') +
    '\n\nThink Beyond Practice';
  await sendRaw({ from: FROM, to: data.toEmail, subject: 'Your session with ' + (data.sellerName || 'your mentor') + ' is booked', html: html, text: text, ics: ics });
}

// Notification to the SELLER. data: { toEmail, sellerName, buyerEmail, startIso,
//   sellerTz, kind, toolkitIncluded, topic }
async function sendSellerNotification(data) {
  const when = fmt(data.startIso, data.sellerTz);
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:540px;color:#1a2430">' +
    '<h2 style="font-size:20px;margin:0 0 10px">New booking</h2>' +
    '<p style="font-size:15px;line-height:1.6"><strong>' + esc(when) + '</strong><br>' +
    'Buyer: ' + esc(data.buyerEmail) + '<br>' +
    'Type: ' + (data.toolkitIncluded ? 'Practice Launch (session + toolkit)' : 'Mentoring session') + '</p>' +
    (data.topic ? '<p style="font-size:15px;line-height:1.6"><strong>What they want help with:</strong><br>' + esc(data.topic) + '</p>' : '') +
    '<p style="font-size:13px;color:#8a94a0">Think Beyond Practice</p></div>';
  const text = 'New booking\n' + when + '\nBuyer: ' + data.buyerEmail +
    '\nType: ' + (data.toolkitIncluded ? 'Practice Launch (session + toolkit)' : 'Mentoring session') +
    (data.topic ? ('\n\nWhat they want help with:\n' + data.topic) : '');
  await sendRaw({ from: FROM, to: data.toEmail, subject: 'New booking — ' + when, html: html, text: text });
}

module.exports = { sendBuyerConfirmation, sendSellerNotification, fmt };

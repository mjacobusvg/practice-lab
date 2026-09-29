// netlify/functions/ses-notifications.js
//
// Receives Amazon SES bounce + complaint notifications (delivered over an SNS HTTP
// subscription) and maintains the email suppression list, so the drip and broadcasts
// stop emailing dead or hostile addresses. This protects SES sender reputation:
// AWS throttles or pauses an account whose bounce rate crosses ~5% or complaint rate
// ~0.1%, which would break every send, including sign-in email.
//
// What it does:
//   - SubscriptionConfirmation: auto-confirms by fetching SubscribeURL (one time).
//   - Notification, Bounce (Permanent only): suppress each bounced recipient.
//   - Notification, Complaint: suppress AND unsubscribe each complainer.
//   - Transient bounces and Delivery notices: ignored (SES retries transients).
//
// Security: every message's SNS signature is verified (v1 RSA-SHA1 / v2 RSA-SHA256)
// against the AWS signing cert, and an unsigned or forged message is rejected 403.
// A spoofed call here could suppress real users, so this is not optional.
//
// Setup (AWS console, one time): create an SNS topic, set the SES configuration
// set / identity to publish Bounce + Complaint to it, then add an HTTPS subscription
// to https://thinkbeyondpractice.com/.netlify/functions/ses-notifications . Optionally
// set env SES_SNS_TOPIC_ARN to that topic's ARN to reject notices from any other topic.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, optional SES_SNS_TOPIC_ARN.

const crypto = require('crypto');
const { suppress } = require('./_lib/suppression');

// Build the exact string SNS signed, field order per the AWS spec.
function canonical(msg) {
  const lines = [];
  const add = (k) => { lines.push(k); lines.push(String(msg[k])); };
  if (msg.Type === 'Notification') {
    add('Message'); add('MessageId');
    if (msg.Subject !== undefined && msg.Subject !== null) add('Subject');
    add('Timestamp'); add('TopicArn'); add('Type');
  } else { // SubscriptionConfirmation / UnsubscribeConfirmation
    add('Message'); add('MessageId'); add('SubscribeURL');
    add('Timestamp'); add('Token'); add('TopicArn'); add('Type');
  }
  return lines.join('\n') + '\n';
}

async function verifySignature(msg) {
  try {
    if (!msg || !msg.Signature || !msg.SigningCertURL) return false;
    const u = new URL(String(msg.SigningCertURL));
    // Cert MUST come from an AWS SNS host over https, never an attacker's URL.
    if (u.protocol !== 'https:') return false;
    if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) return false;
    const res = await fetch(u.toString());
    if (!res.ok) return false;
    const pem = await res.text();
    const algo = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    const v = crypto.createVerify(algo);
    v.update(canonical(msg), 'utf8');
    return v.verify(pem, msg.Signature, 'base64');
  } catch (e) { return false; }
}

async function unsubscribeContact(email) {
  const e = String(email || '').toLowerCase().trim();
  const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!e || !URL || !KEY) return;
  try {
    await fetch(URL + '/rest/v1/contacts?email=eq.' + encodeURIComponent(e), {
      method: 'PATCH',
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ subscribed: false, updated_at: new Date().toISOString() })
    });
  } catch (e2) { /* best effort */ }
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  let msg;
  try { msg = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Optional topic allowlist.
  const allow = process.env.SES_SNS_TOPIC_ARN;
  if (allow && msg.TopicArn && msg.TopicArn !== allow) {
    console.warn('ses-notifications: unexpected TopicArn', msg.TopicArn);
    return { statusCode: 200, headers, body: JSON.stringify({ ignored: 'topic' }) };
  }

  // Verify the SNS signature before trusting anything in the body.
  const good = await verifySignature(msg);
  if (!good) {
    console.warn('ses-notifications: signature verification failed', msg.Type, msg.MessageId);
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Signature verification failed' }) };
  }

  // First-contact handshake from AWS.
  if (msg.Type === 'SubscriptionConfirmation') {
    try { if (msg.SubscribeURL) await fetch(msg.SubscribeURL); } catch (e) { /* AWS retries */ }
    console.log('ses-notifications: subscription confirmed for', msg.TopicArn);
    return { statusCode: 200, headers, body: JSON.stringify({ confirmed: true }) };
  }

  if (msg.Type === 'Notification') {
    let n;
    try { n = JSON.parse(msg.Message || '{}'); } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ ignored: 'unparseable message' }) };
    }
    const out = { received: true, type: n.notificationType, suppressed: 0 };
    try {
      if (n.notificationType === 'Bounce' && n.bounce) {
        // Only Permanent (hard) bounces suppress; Transient are temporary and SES retries.
        if (n.bounce.bounceType === 'Permanent') {
          for (const r of (n.bounce.bouncedRecipients || [])) {
            const ok = await suppress(r.emailAddress, {
              reason: 'bounce', bounce_type: 'Permanent',
              subtype: n.bounce.bounceSubType, detail: r.diagnosticCode || r.status
            });
            if (ok) out.suppressed++;
          }
        }
      } else if (n.notificationType === 'Complaint' && n.complaint) {
        for (const r of (n.complaint.complainedRecipients || [])) {
          const ok = await suppress(r.emailAddress, {
            reason: 'complaint', subtype: n.complaint.complaintFeedbackType, detail: n.complaint.feedbackId
          });
          if (ok) { out.suppressed++; await unsubscribeContact(r.emailAddress); }
        }
      }
      // Delivery notices etc.: acknowledged, no action.
    } catch (e) {
      console.warn('ses-notifications: handling error', e && e.message);
    }
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ received: true, type: msg.Type }) };
};

// netlify/functions/fax-webhook.js
// Receives Notifyre webhook events for fax delivery status.
// On failure, emails the clinician via Amazon SES (under the AWS BAA) to notify them.
//
// Environment variables:
//   NOTIFYRE_API_KEY - for verifying webhook origin (future)
//   SUPABASE_URL - for logging (optional)
//   SUPABASE_SERVICE_KEY - for logging (optional)
//   SES_REGION / AWS_REGION - SES region (default us-east-1)
//   SES_ACCESS_KEY_ID / AWS_ACCESS_KEY_ID - SES credentials
//   SES_SECRET_ACCESS_KEY / AWS_SECRET_ACCESS_KEY - SES credentials
//   FAX_NOTIFY_FROM - optional sender override (default support@thinkbeyondpractice.com)
//
// Notifyre webhook payload for fax_sent:
//   Event: "fax_sent"
//   Timestamp: unix timestamp
//   Payload: { ID, RecipientID, FromNumber, To, Reference, Status, StatusMessage, Pages, ... }
//
// Status values: "accepted", "successful", "failed", "in_progress", "queued"

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const crypto = require('crypto');

// Verifies a Notifyre webhook signature in a fail-open-with-logging posture.
// Returns { matched: bool, attempted: bool, detail }. While Notifyre's exact scheme
// (header name, hex vs base64, body-only vs timestamp+body) is unconfirmed, this tries
// the common variants and LOGS the outcome but does not reject — so a wrong guess can
// never silently kill failure notifications. Once the real scheme is confirmed from a
// captured webhook, flip WEBHOOK_VERIFY_ENFORCE to true to reject on mismatch.
var WEBHOOK_VERIFY_ENFORCE = false;

function verifyNotifyreSignature(event, rawBody) {
  var secret = process.env.NOTIFYRE_WEBHOOK_SECRET;
  if (!secret) return { matched: false, attempted: false, detail: 'no secret configured' };
  var h = event.headers || {};
  // Normalize header keys to lowercase for lookup.
  var lower = {};
  Object.keys(h).forEach(function(k) { lower[k.toLowerCase()] = h[k]; });
  // Candidate header names providers commonly use.
  var candidates = ['x-signature', 'x-signature-sha256', 'x-notifyre-signature', 'notifyre-signature', 'webhook-signature', 'x-webhook-signature', 'x-hub-signature-256'];
  var provided = '';
  var usedHeader = '';
  for (var i = 0; i < candidates.length; i++) {
    if (lower[candidates[i]]) { provided = lower[candidates[i]]; usedHeader = candidates[i]; break; }
  }
  if (!provided) return { matched: false, attempted: false, detail: 'no signature header present' };

  // Strip a possible "sha256=" or "v1," style prefix.
  var providedClean = provided;
  if (providedClean.indexOf('=') !== -1 && /^(sha256|v1)/.test(providedClean)) {
    providedClean = providedClean.split('=').pop();
  }
  if (providedClean.indexOf(',') !== -1) {
    providedClean = providedClean.split(',').pop();
  }

  // Try body-only, in both hex and base64.
  var tries = [
    crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'),
    crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')
  ];
  // Also try timestamp+body if a timestamp header is present (some providers do t.body).
  var ts = lower['x-timestamp'] || lower['webhook-timestamp'] || lower['x-notifyre-timestamp'];
  if (ts) {
    tries.push(crypto.createHmac('sha256', secret).update(ts + '.' + rawBody, 'utf8').digest('hex'));
    tries.push(crypto.createHmac('sha256', secret).update(ts + '.' + rawBody, 'utf8').digest('base64'));
  }
  var matched = tries.some(function(t) { return t === providedClean; });
  return { matched: matched, attempted: true, detail: 'header=' + usedHeader, provided: providedClean };
}

exports.handler = async function(event) {
  var headers = {
    'Content-Type': 'application/json'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    var rawBody = event.body || '';

    // Signature verification (fail-open while scheme is unconfirmed). Log the header
    // names present so the real Notifyre scheme can be confirmed from a live call.
    var sig = verifyNotifyreSignature(event, rawBody);
    console.log('[fax-webhook] sig check:', JSON.stringify(sig), 'headers present:', JSON.stringify(Object.keys(event.headers || {})));
    if (WEBHOOK_VERIFY_ENFORCE && sig.attempted && !sig.matched) {
      return { statusCode: 401, headers: headers, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    var payload = JSON.parse(rawBody);
    var eventType = payload.Event || payload.event;
    var data = payload.Payload || payload.payload;

    // Only process fax_sent events
    if (eventType !== 'fax_sent') {
      return { statusCode: 200, headers: headers, body: JSON.stringify({ status: 'ignored', event: eventType }) };
    }

    var status = (data.Status || data.status || '').toLowerCase();
    var to = data.To || data.to || '';
    var reference = data.Reference || data.ClientReference || data.reference || '';
    var statusMessage = data.StatusMessage || data.statusMessage || '';
    var faxId = data.ID || data.id || '';
    var pages = data.Pages || data.pages || 0;

    // Log all fax events to Supabase
    var supabaseUrl = process.env.SUPABASE_URL;
    var supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (supabaseUrl && supabaseKey) {
      fetch(supabaseUrl + '/rest/v1/tool_usage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          tool: 'Fax Webhook',
          mode: 'fax_status',
          event: status + '_to_' + to.slice(-4),
          created_at: new Date().toISOString()
        })
      }).catch(function(e) { console.log('Log error:', e.message); });
    }

    // Decide whether this is a delivery FAILURE worth notifying. Rather than match a
    // guessed list of failure tokens (Notifyre reports the detail in StatusMessage, not
    // always as a distinct status), treat anything that is NOT a success or a still-in-
    // progress state as a failure. This errs toward notifying on real failures rather
    // than silently swallowing one, which is the priority for clinical faxes.
    var successStatuses = ['successful', 'completed', 'delivered', 'sent'];
    var inProgressStatuses = ['accepted', 'queued', 'in_progress', 'in-progress', 'preparing', 'sending'];
    if (successStatuses.indexOf(status) !== -1) {
      return { statusCode: 200, headers: headers, body: JSON.stringify({ status: 'ok', fax_status: status }) };
    }
    if (inProgressStatuses.indexOf(status) !== -1) {
      return { statusCode: 200, headers: headers, body: JSON.stringify({ status: 'pending', fax_status: status }) };
    }
    // Anything else (failed, no-answer, busy, cancelled, error, unknown) -> notify.

    // Parse clinician email from the reference field
    // Reference format: "Tool Name - Subject | clinician@email.com"
    var clinicianEmail = '';
    if (reference && reference.indexOf('|') !== -1) {
      clinicianEmail = reference.split('|').pop().trim();
    }

    // If no clinician email in reference, we can't notify anyone
    if (!clinicianEmail || clinicianEmail.indexOf('@') === -1) {
      console.log('Fax failed but no clinician email in reference:', reference);
      return { statusCode: 200, headers: headers, body: JSON.stringify({ status: 'failed_no_notify', reason: 'no clinician email in reference' }) };
    }

    // Build failure reason
    var failureReasons = {
      'failed': 'The fax transmission failed.',
      'no-answer': 'The receiving fax machine did not answer.',
      'busy': 'The receiving fax line was busy.',
      'cancelled': 'The fax was cancelled.'
    };
    var reason = failureReasons[status] || 'The fax could not be delivered (status: ' + status + ').';

    var subject = 'Fax Delivery Failed - ' + to;
    var emailBody = 'Your fax to ' + to + ' was not delivered.\n\n';
    emailBody += 'Reason: ' + reason + '\n';
    if (statusMessage) emailBody += 'Details: ' + statusMessage + '\n';
    emailBody += '\nWhat to do next:\n';
    emailBody += '1. Verify the fax number is correct\n';
    emailBody += '2. Try sending again (the recipient fax machine may have been busy or turned off)\n';
    emailBody += '3. If the problem persists, call the recipient to confirm their fax number and that their machine is on\n\n';
    emailBody += 'You can resend the fax from the same tool in Practice Manager.\n\n';
    emailBody += 'Think Beyond Practice';

    // Send failure notification via Amazon SES (under the AWS BAA).
    // Use the SAME env var names as send-document.js (the proven SES path): SES_AWS_*.
    // Fall back to the older names so this works whichever set is configured.
    var region = process.env.SES_AWS_REGION || process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
    var accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    var secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    var fromAddress = process.env.FAX_NOTIFY_FROM || 'Think Beyond Practice <support@thinkbeyondpractice.com>';

    var sesConfig = { region: region };
    if (accessKeyId && secretAccessKey) {
      sesConfig.credentials = { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey };
    }

    var sesClient = new SESv2Client(sesConfig);
    await sesClient.send(new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [clinicianEmail] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: emailBody, Charset: 'UTF-8' } }
        }
      }
    }));

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ status: 'failure_notification_sent', to: clinicianEmail })
    };

  } catch (err) {
    console.error('Fax webhook error:', err);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
  }
};

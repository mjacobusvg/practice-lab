// netlify/functions/fax-webhook.js
// Receives Notifyre webhook events for fax delivery status.
// On failure, emails the clinician via Resend to notify them.
//
// Environment variables:
//   NOTIFYRE_API_KEY - for verifying webhook origin (future)
//   RESEND_API_KEY - for sending failure notification emails
//   SUPABASE_URL - for logging (optional)
//   SUPABASE_SERVICE_KEY - for logging (optional)
//
// Notifyre webhook payload for fax_sent:
//   Event: "fax_sent"
//   Timestamp: unix timestamp
//   Payload: { ID, RecipientID, FromNumber, To, Reference, Status, StatusMessage, Pages, ... }
//
// Status values: "accepted", "successful", "failed", "in_progress", "queued"

exports.handler = async function(event) {
  var headers = {
    'Content-Type': 'application/json'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    var payload = JSON.parse(event.body);
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

    // Only send notification on failure statuses
    var failureStatuses = ['failed', 'no-answer', 'busy', 'cancelled'];
    if (failureStatuses.indexOf(status) === -1) {
      return { statusCode: 200, headers: headers, body: JSON.stringify({ status: 'ok', fax_status: status }) };
    }

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

    // Send failure notification via Resend
    var resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      console.log('RESEND_API_KEY not set, cannot send fax failure notification');
      return { statusCode: 200, headers: headers, body: JSON.stringify({ status: 'failed_no_resend' }) };
    }

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

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + resendKey
      },
      body: JSON.stringify({
        from: 'Think Beyond Practice <support@thinkbeyondpractice.com>',
        to: [clinicianEmail],
        subject: subject,
        text: emailBody
      })
    });

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

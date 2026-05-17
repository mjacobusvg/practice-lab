// netlify/functions/send-sms.js
// Sends SMS via Notifyre REST API (no npm dependencies).
// Designed for clinical use cases: safety plan delivery, assessment links, appointment reminders.
//
// Environment variables:
//   NOTIFYRE_API_KEY - Notifyre API token
//
// Request body:
//   to: phone number (e.g. "+15095551234" or "509-555-1234")
//   message: SMS message text (max 1600 chars / 10 parts)
//   tool: which tool sent this (for logging)

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  var apiKey = process.env.NOTIFYRE_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'SMS service not configured. Set NOTIFYRE_API_KEY in Netlify environment variables.' })
    };
  }

  try {
    var payload = JSON.parse(event.body);
    var to = payload.to;
    var message = payload.message;
    var tool = payload.tool || 'Practice Manager';

    if (!to || !message) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: 'Missing required fields: to (phone number) and message' })
      };
    }

    // Enforce message length limit (10 SMS parts max)
    if (message.length > 1600) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: 'Message too long. Maximum 1600 characters.' })
      };
    }

    // Clean phone number: strip everything except digits and leading +
    var cleanNumber = to.replace(/[^\d+]/g, '');
    if (!cleanNumber.startsWith('+')) {
      // Assume US number if no country code
      cleanNumber = '+1' + cleanNumber.replace(/^1/, '');
    }

    // Validate: should be +1 followed by 10 digits for US
    if (!/^\+\d{10,15}$/.test(cleanNumber)) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: 'Invalid phone number format. Use a US phone number (e.g. 509-555-1234).' })
      };
    }

    // Send via Notifyre SMS API
    var smsPayload = {
      Recipients: [
        {
          Type: 'MobileNumber',
          Value: cleanNumber
        }
      ],
      Body: message,
      ClientReference: tool
    };

    var sendRes = await fetch('https://api.notifyre.com/sms/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': apiKey
      },
      body: JSON.stringify(smsPayload)
    });

    var sendResult = await sendRes.json();

    if (!sendRes.ok || !sendResult.Success) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: 'SMS send failed: ' + (sendResult.Message || JSON.stringify(sendResult)) })
      };
    }

    // Log to Supabase if available
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
          tool: tool,
          mode: 'send_sms',
          event: 'sms_sent_to_' + cleanNumber.slice(-4),
          created_at: new Date().toISOString()
        })
      }).catch(function(e) { console.log('Usage log error:', e.message); });
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        success: true,
        smsId: sendResult.Payload ? (sendResult.Payload.SmsID || sendResult.Payload.ID || null) : null,
        message: 'SMS sent to ' + cleanNumber
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};

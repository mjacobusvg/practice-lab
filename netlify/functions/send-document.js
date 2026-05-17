// netlify/functions/send-document.js
// Shared send utility for all Practice Manager tools.
// Sends documents via Resend API using raw fetch (no npm dependencies).
//
// Environment variables:
//   RESEND_API_KEY - Resend API key
//   SUPABASE_URL - for usage logging (optional)
//   SUPABASE_SERVICE_KEY - for usage logging (optional)
//
// Request body:
//   to: recipient email address
//   subject: email subject line
//   body: plain text body
//   htmlBody: (optional) HTML body
//   replyTo: (optional) clinician's email for reply-to header
//   tool: which tool sent this (for logging)

var FROM_ADDRESS = 'support@thinkbeyondpractice.com';
var FROM_NAME = 'Think Beyond Practice';

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

  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'Email service not configured. Set RESEND_API_KEY in Netlify environment variables.' })
    };
  }

  try {
    var payload = JSON.parse(event.body);
    var to = payload.to;
    var subject = payload.subject;
    var textBody = payload.body;
    var htmlBody = payload.htmlBody;
    var replyTo = payload.replyTo;
    var tool = payload.tool;

    if (!to || !subject || (!textBody && !htmlBody)) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: 'Missing required fields: to, subject, and body or htmlBody' })
      };
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: 'Invalid email address' })
      };
    }

    // Build Resend API payload
    var emailPayload = {
      from: FROM_NAME + ' <' + FROM_ADDRESS + '>',
      to: [to],
      subject: subject
    };

    if (textBody) emailPayload.text = textBody;
    if (htmlBody) emailPayload.html = htmlBody;
    if (replyTo) emailPayload.reply_to = replyTo;

    // Send via Resend REST API (no npm package needed)
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify(emailPayload)
    });

    var result = await res.json();

    if (!res.ok) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: (result.message || result.error || 'Resend API error') })
      };
    }

    // Log to Supabase (async, don't block response)
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
          tool: tool || 'Practice Manager',
          mode: 'send_document',
          event: 'email_sent_to_' + to.split('@')[1],
          created_at: new Date().toISOString()
        })
      }).catch(function(e) { console.log('Usage log error:', e.message); });
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({ success: true, messageId: result.id || null })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};

// netlify/functions/send-document.js
// Shared send utility for all Practice Manager tools.
// Sends documents via Amazon SES using the SES v2 HTTPS API (AWS SDK v3).
//
// NOTE: Uses the HTTPS API, not SMTP. SMTP connections are unreliable from
// Netlify/Lambda functions (getaddrinfo EBUSY); the HTTPS API works in the
// same environment where anthropic-proxy.js already works.
//
// Environment variables (set in Netlify):
//   SES_AWS_ACCESS_KEY_ID     - IAM access key ID with ses:SendEmail permission
//   SES_AWS_SECRET_ACCESS_KEY - IAM secret access key
//   SES_AWS_REGION            - us-east-1 (optional; defaults to us-east-1)
//   SUPABASE_URL              - for usage logging (optional)
//   SUPABASE_SERVICE_KEY      - for usage logging (optional)
//
// (Netlify reserves AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, so we use
//  SES_-prefixed variable names to avoid the reserved keys.)
//
// Request body:
//   to: recipient email address
//   subject: email subject line
//   body: plain text body
//   htmlBody: (optional) HTML body
//   replyTo: (optional) clinician's email for reply-to header
//   tool: which tool sent this (for logging)

var SESv2 = require('@aws-sdk/client-sesv2');

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

  var accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID;
  var secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY;
  var region = process.env.SES_AWS_REGION || 'us-east-1';

  if (!accessKeyId || !secretAccessKey) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'Email service not configured. Set SES_AWS_ACCESS_KEY_ID and SES_AWS_SECRET_ACCESS_KEY in Netlify environment variables.' })
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

    var client = new SESv2.SESv2Client({
      region: region,
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey
      }
    });

    // Build the message body (text and/or HTML)
    var bodyContent = {};
    if (textBody) bodyContent.Text = { Data: textBody, Charset: 'UTF-8' };
    if (htmlBody) bodyContent.Html = { Data: htmlBody, Charset: 'UTF-8' };

    var sendParams = {
      FromEmailAddress: FROM_NAME + ' <' + FROM_ADDRESS + '>',
      Destination: {
        ToAddresses: [to]
      },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: bodyContent
        }
      }
    };

    if (replyTo) {
      sendParams.ReplyToAddresses = [replyTo];
    }

    var result;
    try {
      var command = new SESv2.SendEmailCommand(sendParams);
      result = await client.send(command);
    } catch (sendErr) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: (sendErr.message || 'SES send error') })
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
      body: JSON.stringify({ success: true, messageId: (result && result.MessageId) || null })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};

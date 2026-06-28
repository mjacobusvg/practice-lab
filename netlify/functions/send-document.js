var { verifyToken } = require('./_lib/session');
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

    // AUTH: clinical sender — full-tier only. Identity from signed token (body.token or
    // Authorization: Bearer). Closes the open send-relay hole (spam/PHI/toll-fraud on our
    // accounts). Server-side callers must forward the provider's token.
    var __authHeader = event.headers.authorization || event.headers.Authorization || '';
    var __sessionToken = (payload.token || __authHeader.replace(/^Bearer\s+/i, '')).trim();
    var __session = verifyToken(__sessionToken);
    if (!__session.valid) {
      return { statusCode: 401, headers: headers, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }
    if (!(__session.claims.scope === 'member' && __session.claims.tier === 'full')) {
      return { statusCode: 403, headers: headers, body: JSON.stringify({ error: 'This tool requires the full Think Beyond Practice membership.' }) };
    }

    var to = payload.to;
    var subject = payload.subject;
    var textBody = payload.body;
    var htmlBody = payload.htmlBody;
    var replyTo = payload.replyTo;
    var tool = payload.tool;
    var attachmentBase64 = payload.attachmentBase64 || '';
    var attachmentFilename = payload.attachmentFilename || 'attachment.pdf';
    var attachmentContentType = payload.attachmentContentType || 'application/pdf';

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

    var sendParams;
    if (attachmentBase64) {
      // Attachment present: SES v2 Simple content cannot attach files, so build a
      // raw MIME message (multipart/mixed: body as multipart/alternative + the PDF).
      var rawMime = buildRawMime({
        fromName: FROM_NAME,
        fromAddress: FROM_ADDRESS,
        to: to,
        replyTo: replyTo,
        subject: subject,
        textBody: textBody || '',
        htmlBody: htmlBody || '',
        attachmentBase64: attachmentBase64,
        attachmentFilename: attachmentFilename,
        attachmentContentType: attachmentContentType
      });
      sendParams = {
        FromEmailAddress: FROM_NAME + ' <' + FROM_ADDRESS + '>',
        Destination: { ToAddresses: [to] },
        Content: { Raw: { Data: Buffer.from(rawMime, 'utf8') } }
      };
      if (replyTo) sendParams.ReplyToAddresses = [replyTo];
    } else {
      sendParams = {
        FromEmailAddress: FROM_NAME + ' <' + FROM_ADDRESS + '>',
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: bodyContent
          }
        }
      };
      if (replyTo) sendParams.ReplyToAddresses = [replyTo];
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

// Builds a raw RFC 5322 MIME message: multipart/mixed wrapping a
// multipart/alternative (text + HTML cover) and a base64 file attachment.
function buildRawMime(o) {
  var CRLF = '\r\n';
  var mixed = 'mixed_' + Math.random().toString(36).slice(2);
  var alt = 'alt_' + Math.random().toString(36).slice(2);

  function header(name, val) { return name + ': ' + val + CRLF; }

  var msg = '';
  msg += header('From', o.fromName + ' <' + o.fromAddress + '>');
  msg += header('To', o.to);
  if (o.replyTo) msg += header('Reply-To', o.replyTo);
  msg += header('Subject', mimeEncodeHeader(o.subject));
  msg += header('MIME-Version', '1.0');
  msg += header('Content-Type', 'multipart/mixed; boundary="' + mixed + '"');
  msg += CRLF;

  // multipart/alternative part (text + html cover note)
  msg += '--' + mixed + CRLF;
  msg += header('Content-Type', 'multipart/alternative; boundary="' + alt + '"');
  msg += CRLF;

  if (o.textBody) {
    msg += '--' + alt + CRLF;
    msg += header('Content-Type', 'text/plain; charset="UTF-8"');
    msg += header('Content-Transfer-Encoding', 'base64');
    msg += CRLF;
    msg += chunk76(Buffer.from(o.textBody, 'utf8').toString('base64')) + CRLF;
  }
  if (o.htmlBody) {
    msg += '--' + alt + CRLF;
    msg += header('Content-Type', 'text/html; charset="UTF-8"');
    msg += header('Content-Transfer-Encoding', 'base64');
    msg += CRLF;
    msg += chunk76(Buffer.from(o.htmlBody, 'utf8').toString('base64')) + CRLF;
  }
  msg += '--' + alt + '--' + CRLF;

  // attachment part
  msg += '--' + mixed + CRLF;
  msg += header('Content-Type', o.attachmentContentType + '; name="' + o.attachmentFilename + '"');
  msg += header('Content-Transfer-Encoding', 'base64');
  msg += header('Content-Disposition', 'attachment; filename="' + o.attachmentFilename + '"');
  msg += CRLF;
  msg += chunk76(o.attachmentBase64) + CRLF;
  msg += '--' + mixed + '--' + CRLF;

  return msg;
}

// Wrap base64 at 76 chars per RFC 2045.
function chunk76(b64) {
  return (b64 || '').replace(/(.{76})/g, '$1\r\n');
}

// RFC 2047 encode a header value if it contains non-ASCII; otherwise pass through.
function mimeEncodeHeader(s) {
  s = s || '';
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

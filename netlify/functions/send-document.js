// netlify/functions/send-document.js
// Shared send utility for all Practice Manager tools.
// Sends documents via Amazon SES (SMTP) using nodemailer.
//
// Environment variables (set in Netlify):
//   SES_SMTP_HOST     - email-smtp.us-east-1.amazonses.com
//   SES_SMTP_PORT     - 587
//   SES_SMTP_USER     - SES SMTP username (starts with AKIA...)
//   SES_SMTP_PASS     - SES SMTP password
//   SUPABASE_URL      - for usage logging (optional)
//   SUPABASE_SERVICE_KEY - for usage logging (optional)
//
// Request body:
//   to: recipient email address
//   subject: email subject line
//   body: plain text body
//   htmlBody: (optional) HTML body
//   replyTo: (optional) clinician's email for reply-to header
//   tool: which tool sent this (for logging)

var nodemailer = require('nodemailer');

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

  var smtpUser = process.env.SES_SMTP_USER;
  var smtpPass = process.env.SES_SMTP_PASS;
  var smtpHost = process.env.SES_SMTP_HOST || 'email-smtp.us-east-1.amazonses.com';
  var smtpPort = parseInt(process.env.SES_SMTP_PORT || '587', 10);

  if (!smtpUser || !smtpPass) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'Email service not configured. Set SES_SMTP_USER and SES_SMTP_PASS in Netlify environment variables.' })
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

    // Configure SES SMTP transport (STARTTLS on port 587)
    var transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465, // true only for port 465 (TLS wrapper); false for 587 STARTTLS
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });

    var mailOptions = {
      from: FROM_NAME + ' <' + FROM_ADDRESS + '>',
      to: to,
      subject: subject
    };

    if (textBody) mailOptions.text = textBody;
    if (htmlBody) mailOptions.html = htmlBody;
    if (replyTo) mailOptions.replyTo = replyTo;

    var info;
    try {
      info = await transporter.sendMail(mailOptions);
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
      body: JSON.stringify({ success: true, messageId: (info && info.messageId) || null })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};

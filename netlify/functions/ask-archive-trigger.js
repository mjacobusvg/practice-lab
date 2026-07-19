// netlify/functions/ask-archive-trigger.js
// Lightweight dispatcher — creates job row in Supabase, sends event to Inngest, returns job_id immediately.

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { verifyToken } = require('./_lib/session');

// Internal notification email via Amazon SES (under the AWS BAA).
// Replaces the previous Resend integration so all outbound mail runs through SES.
// NOTE: env var names below should match those used by your other SES functions.
async function sendNotification(subject, html) {
  const region = process.env.SES_AWS_REGION || process.env.SES_REGION || 'us-east-1';
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
  const fromAddress = process.env.SES_FROM || 'Ask the Archive <noreply@thinkbeyondpractice.com>';
  const toAddress = process.env.NOTIFY_TO || 'michael@thinkbeyondpractice.com';

  const config = { region };
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  }

  try {
    const client = new SESv2Client(config);
    await client.send(new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [toAddress] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' } }
        }
      }
    }));
  } catch (e) {
    console.log('SES notification error:', e.message);
  }
}

exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const question = (body.question || '').trim();
  if (!question) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Question required' }) };
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  // Handle template request inline — no background job needed
  if (body.request_template === true) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/unanswered_questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ question: `[TEMPLATE REQUEST] ${question}`, member_requested: true, created_at: new Date().toISOString() })
      });
      await sendNotification('Ask the Archive — Template Request', `<p>A member requested a template for:</p><blockquote>${question}</blockquote>`);
    } catch(e) {}
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'Template request submitted.' }) };
  }
  // Generate job ID
  const job_id = 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
  // Create job row in Supabase
  try {
    await fetch(`${supabaseUrl}/rest/v1/archive_jobs?on_conflict=job_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ job_id, status: 'pending', created_at: new Date().toISOString() })
    });
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to create job' }) };
  }
  // Best-effort identity for usage attribution. Ask the Archive is mostly public,
  // so a token may not be present; when it is, forward the verified email + tier
  // to the pipeline so its AI usage is attributed. Never gates the request.
  let account_email = null, tier = null;
  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
    if (sessionToken) {
      const session = verifyToken(sessionToken);
      if (session.valid) { account_email = session.claims.email || null; tier = session.claims.tier || null; }
    }
  } catch (e) {}

  // Send event to Inngest
  try {
    const { Inngest } = await import('inngest');
    const inngest = new Inngest({ id: 'think-beyond-practice' });
    await inngest.send({
      name: 'ask-archive/question.submitted',
      data: {
        job_id,
        question,
        member_requested: body.member_requested || false,
        conversation_history: body.conversation_history || [],
        account_email,
        tier
      }
    });
  } catch(e) {
    console.error('Inngest trigger error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to queue job' }) };
  }
  return {
    statusCode: 202,
    headers: CORS,
    body: JSON.stringify({ job_id, status: 'pending' })
  };
};

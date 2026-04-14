// netlify/functions/ask-archive-trigger.js
// Lightweight dispatcher — creates job row in Supabase, sends event to Inngest, returns job_id immediately.

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
  const resendKey = process.env.RESEND_API_KEY;

  // Handle template request inline — no background job needed
  if (body.request_template === true) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/unanswered_questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ question: `[TEMPLATE REQUEST] ${question}`, member_requested: true, created_at: new Date().toISOString() })
      });
      if (resendKey) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
          body: JSON.stringify({ from: 'Ask the Archive <noreply@thinkbeyondpractice.com>', to: ['michael@thinkbeyondpsych.com'], subject: 'Ask the Archive — Template Request', html: `<p>A member requested a template for:</p><blockquote>${question}</blockquote>` })
        });
      }
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
        conversation_history: body.conversation_history || []
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

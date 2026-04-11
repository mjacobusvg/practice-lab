// netlify/functions/ask-archive.js
// Lightweight dispatcher — starts background job, returns job_id immediately
// Full pipeline runs in ask-archive-background.js
// Results retrieved via ask-archive-poll.js

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

  // Handle unanswered questions dashboard request
  if (body.action === 'get_unanswered') {
    if (body.secret !== process.env.BACKFILL_SECRET) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
    }
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/unanswered_questions?select=question,member_requested,created_at&order=created_at.desc&limit=500`, {
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
      });
      const questions = await res.json();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ questions }) };
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // Handle feedback submission
  if (body.action === 'feedback') {
    try {
      await fetch(`${supabaseUrl}/rest/v1/archive_feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ job_id: body.job_id || null, question: body.question || '', rating: body.rating || 0, created_at: new Date().toISOString() })
      });
    } catch(e) {}
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
  }

  const question = (body.question || '').trim();
  if (!question) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Question required' }) };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  // Handle template request inline — fast, no background needed
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

  // Generate a unique job ID
  const job_id = 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  // Create job record in Supabase
  try {
    await fetch(`${supabaseUrl}/rest/v1/archive_jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ job_id: job_id, status: 'pending', created_at: new Date().toISOString() })
    });
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to create job' }) };
  }

  // Fire background function — don't await
  fetch(`${process.env.URL || 'https://thinkbeyondpractice.com'}/.netlify/functions/ask-archive-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: job_id,
      question: question,
      member_requested: body.member_requested || false,
      conversation_history: body.conversation_history || []
    })
  }).catch(function(e) { console.log('Background trigger error:', e.message); });

  // Return job_id immediately
  return {
    statusCode: 202,
    headers: CORS,
    body: JSON.stringify({ job_id: job_id, status: 'pending' })
  };
};

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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const resendKey = process.env.RESEND_API_KEY;

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

  // Handle template list
  if (body.action === 'list_templates') {
    if (body.secret !== process.env.BACKFILL_SECRET) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
    }
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/templates?select=*&order=approved.desc,type.asc,title.asc&limit=500`, {
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
      });
      const templates = await res.json();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ templates }) };
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // Handle template file upload
  if (body.action === 'upload_template_file') {
    if (body.secret !== process.env.BACKFILL_SECRET) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
    }
    try {
      const { id, filename, contentType, data } = body;
      const fileBuffer = Buffer.from(data, 'base64');
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `templates/${id}_${safeName}`;

      // Upload to Supabase Storage bucket 'templates'
      const uploadRes = await fetch(
        `${supabaseUrl}/storage/v1/object/templates/${storagePath}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'x-upsert': 'true'
          },
          body: fileBuffer
        }
      );

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Storage upload failed: ' + errText.substring(0, 200) }) };
      }

      // Public URL for the file
      const file_url = `${supabaseUrl}/storage/v1/object/public/templates/${storagePath}`;

      // Update templates table with file_url
      await fetch(`${supabaseUrl}/rest/v1/templates?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ file_url })
      });

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, file_url }) };
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // Handle template update
  if (body.action === 'update_template') {
    if (body.secret !== process.env.BACKFILL_SECRET) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
    }
    try {
      await fetch(`${supabaseUrl}/rest/v1/templates?id=eq.${body.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(body.update)
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // Handle delete single unanswered question
  if (body.action === 'delete_unanswered') {
    if (body.secret !== process.env.BACKFILL_SECRET) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
    }
    try {
      await fetch(`${supabaseUrl}/rest/v1/unanswered_questions?question=eq.${encodeURIComponent(body.question)}`, {
        method: 'DELETE',
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // Handle bulk delete unanswered questions
  if (body.action === 'delete_unanswered_bulk') {
    if (body.secret !== process.env.BACKFILL_SECRET) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
    }
    try {
      const questions = body.questions || [];
      await Promise.all(questions.map(function(q) {
        return fetch(`${supabaseUrl}/rest/v1/unanswered_questions?question=eq.${encodeURIComponent(q)}`, {
          method: 'DELETE',
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
      }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
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

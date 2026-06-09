// netlify/functions/ask-archive.js
// Handles all admin actions, feedback, template requests, and browse/pagination.
// Live query pipeline runs via ask-archive-trigger.js -> Inngest -> inngest-serve.mjs

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

// Internal notification email via Amazon SES (under the AWS BAA).
// Replaces the previous Resend integration so all outbound mail runs through SES.
// NOTE: env var names below should match those used by your other SES functions.
async function sendNotification(subject, html) {
  const region = process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.SES_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

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

      const file_url = `${supabaseUrl}/storage/v1/object/public/templates/${storagePath}`;

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

  // Handle rechunk trigger — fires Inngest event to rechunk all long posts
  if (body.action === 'rechunk') {
    if (body.secret !== process.env.BACKFILL_SECRET) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
    }
    try {
      const { Inngest } = await import('inngest');
      const inngest = new Inngest({ id: 'think-beyond-practice' });
      await inngest.send({
        name: 'archive/rechunk.posts',
        data: { secret: body.secret }
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
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
      await sendNotification('Ask the Archive — Template Request', `<p>A member requested a template for:</p><blockquote>${question}</blockquote>`);
    } catch(e) {}
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'Template request submitted.' }) };
  }

  // Handle member_requested topic log
  if (body.member_requested === true) {
    try {
      await fetch(`${supabaseUrl}/rest/v1/unanswered_questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ question, member_requested: true, created_at: new Date().toISOString() })
      });
      await sendNotification('Ask the Archive — Topic Request', `<p>A member requested this topic:</p><blockquote>${question}</blockquote>`);
    } catch(e) {}
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
  }

  // Browse/pagination — direct FTS, no Inngest needed
  if (body.page && body.page > 1) {
    try {
      const ftsRes = await fetch(`${supabaseUrl}/rest/v1/rpc/search_posts_fts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
        body: JSON.stringify({ search_query: question, match_count: body.page * 10 })
      });
      const all = ftsRes.ok ? await ftsRes.json() : [];
      const page = body.page || 1;
      const offset = (page - 1) * 10;
      const slice = all.slice(offset, offset + 10);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        browse: true,
        posts: slice.map(function(m) { return { title: m.title, space: m.space_name, author: m.author, url: m.url, description: '' }; }),
        has_more: all.length > offset + 10,
        page: page
      })};
    } catch(e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // Fallback — nothing matched
  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unrecognised request' }) };
};

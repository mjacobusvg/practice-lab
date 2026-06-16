// netlify/functions/chart-coder-trigger.js
// Lightweight dispatcher for the Chart Audit + Coder background job.
// Creates a job row in Supabase (tool_jobs), sends an event to Inngest,
// and returns the job_id immediately. The heavy four-pass analysis runs
// server-side in inngest-serve.mjs with no synchronous timeout.
//
// PHI note: the chart note is passed through to the Inngest event and the
// Anthropic API (BAA-covered). It is NOT written to the job row or logged.

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

  const noteText = (body.noteText || '').trim();
  if (!noteText) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Note text required' }) };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  const job_id = 'cc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  // Create job row
  try {
    await fetch(`${supabaseUrl}/rest/v1/tool_jobs?on_conflict=job_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ job_id, tool: 'chart-coder', status: 'pending', created_at: new Date().toISOString() })
    });
  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to create job' }) };
  }

  // Fire Inngest event with everything the pipeline needs
  try {
    const { Inngest } = await import('inngest');
    const inngest = new Inngest({ id: 'think-beyond-practice' });
    await inngest.send({
      name: 'chart-coder/audit.submitted',
      data: {
        job_id,
        noteText,
        visitType: body.visitType || '',
        preflightContext: body.preflightContext || ''
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

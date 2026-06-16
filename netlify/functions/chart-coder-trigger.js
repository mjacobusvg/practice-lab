// netlify/functions/chart-coder-trigger.js
// Lightweight dispatcher for the Chart Audit + Coder background job.
// Creates a job row in Supabase (tool_jobs) and invokes the standalone
// chart-coder-background function (15-min limit) via HTTP, then returns the
// job_id immediately. No Inngest. The browser polls tool_jobs via
// chart-coder-poll.
//
// PHI note: the chart note is forwarded to the background function and the
// Anthropic API (BAA-covered). It is NOT written to the job row or logged.

exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const noteText = (body.noteText || '').trim();
  if (!noteText) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Note text required' }) };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  const job_id = 'cc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  // Create the pending job row
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
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to create job' }) };
  }

  // Invoke the background function directly. Netlify background functions return
  // 202 immediately and continue running up to 15 minutes. The browser polls
  // tool_jobs for the result.
  const host = (event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || 'thinkbeyondpractice.com';
  const proto = (event.headers && event.headers['x-forwarded-proto']) || 'https';
  const bgUrl = `${proto}://${host}/.netlify/functions/chart-coder-background`;

  try {
    await fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id,
        noteText,
        visitType: body.visitType || '',
        preflightContext: body.preflightContext || ''
      })
    });
  } catch (e) {
    console.error('Background invoke error:', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to start background analysis' }) };
  }

  return {
    statusCode: 202,
    headers: CORS,
    body: JSON.stringify({ job_id, status: 'pending' })
  };
};

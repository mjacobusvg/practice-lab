// netlify/functions/ask-archive-poll.js
// Checks if a background job is complete and returns the result

exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { job_id } = body;
  if (!job_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'job_id required' }) };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/archive_jobs?job_id=eq.${job_id}&select=status,result&limit=1`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });

    if (!res.ok) throw new Error('Supabase query failed');

    const rows = await res.json();

    if (!rows || rows.length === 0) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'pending' }) };
    }

    const row = rows[0];
    if (row.status !== 'complete') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'pending' }) };
    }

    const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;

    // Clean up job after retrieval
    fetch(`${supabaseUrl}/rest/v1/archive_jobs?job_id=eq.${job_id}`, {
      method: 'DELETE',
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    }).catch(function() {});

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'complete', result: result }) };

  } catch(err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

// netlify/functions/chart-coder-poll.js
// Checks if a Chart Coder background job is complete and returns the result.
// Mirrors ask-archive-poll.js but reads the shared tool_jobs table.

const { verifyToken } = require('./_lib/session');

// Does this caller own the job? Returns true when the row is unowned (an anonymous
// Ask the Archive question, which is a supported case) or when a valid session token
// carries the same email the job was created with.
//
// SECURITY 2026-09-17. These pollers took a job_id and returned that job's `result` to
// anybody, with the service key, no session check — and the same pattern drives a DELETE,
// so a known id also let a third party destroy someone else's job. For chart-coder the
// result is coding analysis derived from a clinical note. The exposure window is short
// (the poller deletes on retrieval, and tool_jobs holds 0 rows at rest) but "short" is
// not "closed", and the id was `Date.now()` plus six chars of Math.random(), which is not
// a CSPRNG. Jobs are now bound to their creator at trigger time and the id is a UUID.
function ownerMatches(row, event, body) {
  var owner = row && row.owner_email ? String(row.owner_email).toLowerCase().trim() : '';
  if (!owner) return true;  // unowned: anonymous archive question
  try {
    var authHeader = event.headers.authorization || event.headers.Authorization || '';
    var token = ((body && body.token) || authHeader.replace(/^Bearer\s+/i, '')).trim();
    if (!token) return false;
    var session = verifyToken(token);
    if (!session.valid) return false;
    return String(session.claims.email || '').toLowerCase().trim() === owner;
  } catch (e) {
    return false;
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

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { job_id } = body;
  if (!job_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'job_id required' }) };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/tool_jobs?job_id=eq.${encodeURIComponent(job_id)}&select=status,result,owner_email&limit=1`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });

    if (!res.ok) throw new Error('Supabase query failed');

    const rows = await res.json();

    if (!rows || rows.length === 0) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'pending' }) };
    }

    const row = rows[0];

    // Not yours: answer exactly as if it did not exist. A distinct 403 would confirm
    // that this job id is real, which is the thing an id-guesser is probing for.
    if (!ownerMatches(row, event, body)) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'pending' }) };
    }

    if (row.status === 'error') {
      // surface a clean error and clean up
      fetch(`${supabaseUrl}/rest/v1/tool_jobs?job_id=eq.${encodeURIComponent(job_id)}`, {
        method: 'DELETE',
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
      }).catch(function() {});
      const errResult = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'error', error: (errResult && errResult.error) || 'Analysis failed' }) };
    }

    if (row.status !== 'complete') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'pending' }) };
    }

    const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;

    // Clean up job after retrieval
    fetch(`${supabaseUrl}/rest/v1/tool_jobs?job_id=eq.${encodeURIComponent(job_id)}`, {
      method: 'DELETE',
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    }).catch(function() {});

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'complete', result: result }) };

  } catch(err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

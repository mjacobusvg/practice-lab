// netlify/functions/assessment-retrieve.js
//
// Provider-authenticated. Returns the scored report for one assessment the
// provider owns. Marks retrieved_at (does NOT delete — retention is a uniform
// 30-day purge from completion, handled by purge_assessment_phi()).
//
// Also supports two ownership-restricted management actions on the same endpoint:
//   action: 'retrieve' (default) - return scored report
//   action: 'expire'             - manually expire a pending assessment
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIRCLE_API_V2_TOKEN

const { createClient } = require('@supabase/supabase-js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

async function verifyMember(circleToken, email) {
  const res = await fetch(
    'https://app.circle.so/api/v1/community_members/search?email=' + encodeURIComponent(email),
    { headers: { 'Authorization': 'Token ' + circleToken } }
  );
  if (!res.ok) return false;
  const d = await res.json();
  const m = Array.isArray(d) ? d[0] : d;
  return !!(m && m.id);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ubcrrrapedaxkguxniwv.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const CIRCLE_TOKEN = process.env.CIRCLE_API_V2_TOKEN;
  if (!SERVICE_KEY || !CIRCLE_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const providerEmail = (body.providerEmail || '').trim().toLowerCase();
  const assessmentId = (body.assessmentId || '').trim();
  const action = (body.action || 'retrieve').trim();

  if (!providerEmail || !assessmentId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'providerEmail and assessmentId required' }) };
  }

  try {
    const ok = await verifyMember(CIRCLE_TOKEN, providerEmail);
    if (!ok) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'No active membership found.' }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Membership verification failed.' }) };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Load the assessment and confirm ownership.
  const { data: assessment, error: aErr } = await sb
    .from('assessments')
    .select('id, provider_email, patient_name, instrument_set, status, completed_at, purged_at')
    .eq('id', assessmentId)
    .maybeSingle();

  if (aErr) {
    console.error('assessment-retrieve load failed:', aErr);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not load assessment' }) };
  }
  if (!assessment || assessment.provider_email !== providerEmail) {
    // Ownership failure returns 404-style generic to avoid leaking existence.
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Assessment not found' }) };
  }

  // ── Manage: expire a pending assessment ──
  if (action === 'expire') {
    if (assessment.status !== 'pending') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Only pending assessments can be expired.' }) };
    }
    const { error: exErr } = await sb
      .from('assessments')
      .update({ status: 'expired' })
      .eq('id', assessmentId);
    if (exErr) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not expire assessment' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, status: 'expired' }) };
  }

  // ── Retrieve scored report ──
  if (assessment.purged_at) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, purged: true, message: 'The detailed results for this assessment have been deleted under the 30-day retention policy. Summary metadata remains in your dashboard.' }) };
  }
  if (assessment.status === 'pending' || assessment.status === 'expired') {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, pending: assessment.status === 'pending', message: 'This assessment has not been completed by the patient yet.' }) };
  }

  const { data: result, error: rErr } = await sb
    .from('assessment_results')
    .select('responses, scores, flags, created_at')
    .eq('assessment_id', assessmentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (rErr) {
    console.error('assessment-retrieve result load failed:', rErr);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not load results' }) };
  }
  if (!result) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, message: 'No results found for this assessment.' }) };
  }

  // Stamp retrieved_at (first retrieval; does not change retention clock).
  const update = { retrieved_at: new Date().toISOString() };
  if (assessment.status === 'completed') update.status = 'retrieved';
  await sb.from('assessments').update(update).eq('id', assessmentId);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      patientName: assessment.patient_name,
      instrumentSet: assessment.instrument_set,
      completedAt: assessment.completed_at,
      scores: result.scores,
      flags: result.flags || []
    })
  };
};

// netlify/functions/assessment-retrieve.js
//
// Provider-authenticated. Returns the scored report for one assessment the
// provider owns; also supports ownership-restricted 'expire' and 'delete'.
//
// SECURITY (hardened): provider identity comes from the SIGNED SESSION TOKEN
// (verified via _lib/session.js), NOT a client-supplied providerEmail. The
// ownership check now compares the row's provider_email to the TOKEN's verified
// email, so it is meaningful (previously it compared to attacker-supplied input).
//
// action: 'retrieve' (default) | 'expire' | 'delete'
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { createClient } = require('@supabase/supabase-js');
const instruments = require('./assessment-instruments.js');
const { verifyToken } = require('./_lib/session');
const phiS3 = require('./_lib/phi-s3');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ubcrrrapedaxkguxniwv.supabase.co';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.', reason: session.reason }) };
  }
  if (session.claims.scope !== 'member') {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'This tool requires full membership.' }) };
  }
  const providerEmail = (session.claims.email || '').trim().toLowerCase();
  if (!providerEmail) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Session missing identity.' }) };
  }

  const assessmentId = (body.assessmentId || '').trim();
  const action = (body.action || 'retrieve').trim();
  if (!assessmentId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'assessmentId required' }) };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: assessment, error: aErr } = await sb
    .from('assessments')
    .select('id, provider_email, patient_name, patient_s3_key, instrument_set, status, completed_at, purged_at, reason_sent')
    .eq('id', assessmentId)
    .maybeSingle();

  if (aErr) {
    console.error('assessment-retrieve load failed:', aErr);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not load assessment' }) };
  }
  // Ownership: compare to the TOKEN's verified email (now meaningful).
  if (!assessment || assessment.provider_email !== providerEmail) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Assessment not found' }) };
  }

  // ── Manage: expire a pending assessment ──
  if (action === 'expire') {
    if (assessment.status !== 'pending') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Only pending assessments can be expired.' }) };
    }
    const { error: exErr } = await sb.from('assessments').update({ status: 'expired' }).eq('id', assessmentId);
    if (exErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not expire assessment' }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, status: 'expired' }) };
  }

  // ── Manage: clinician-initiated PHI delete ──
  if (action === 'delete') {
    if (assessment.status !== 'completed' && assessment.status !== 'retrieved') {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Only completed assessments can be deleted.' }) };
    }
    if (assessment.purged_at) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, alreadyPurged: true }) };
    }
    // Delete the S3-stored PHI (patient name + result), then the DB rows/keys.
    try {
      const { data: resRows } = await sb.from('assessment_results').select('result_s3_key').eq('assessment_id', assessmentId);
      for (const rr of (resRows || [])) { if (rr && rr.result_s3_key) await phiS3.deleteObject(rr.result_s3_key); }
      if (assessment.patient_s3_key) await phiS3.deleteObject(assessment.patient_s3_key);
    } catch (e) { console.error('assessment delete (S3) non-fatal:', e); }
    const { error: delErr } = await sb.from('assessment_results').delete().eq('assessment_id', assessmentId);
    if (delErr) {
      console.error('assessment delete (results) failed:', delErr);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not delete results' }) };
    }
    const { error: updErr } = await sb.from('assessments').update({ patient_name: null, patient_s3_key: null, purged_at: new Date().toISOString() }).eq('id', assessmentId);
    if (updErr) {
      console.error('assessment delete (mark purged) failed:', updErr);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Results deleted but record update failed' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, deleted: true }) };
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
    .select('responses, scores, flags, result_s3_key, created_at')
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

  // Result PHI lives in S3 (new rows); fall back to inline columns for legacy rows.
  let responses = result.responses || {};
  let scores = result.scores || [];
  let flags = result.flags || [];
  if (result.result_s3_key) {
    const blob = await phiS3.getJson(result.result_s3_key);
    responses = blob.responses || {};
    scores = blob.scores || [];
    flags = blob.flags || [];
  }
  // Patient name lives in S3 (new rows); fall back to the legacy column.
  let patientName = assessment.patient_name || null;
  if (assessment.patient_s3_key) {
    const p = await phiS3.getJson(assessment.patient_s3_key);
    patientName = p.patient_name || patientName;
  }

  const update = { retrieved_at: new Date().toISOString() };
  if (assessment.status === 'completed') update.status = 'retrieved';
  await sb.from('assessments').update(update).eq('id', assessmentId);

  const battery = { results: scores, flags: flags };
  let screenerReviewBlurb = '';
  let hpiSymptomBlurb = '';
  try {
    screenerReviewBlurb = instruments.screenerReviewBlurb(battery, assessment.reason_sent);
    hpiSymptomBlurb = instruments.hpiSymptomBlurb(battery, responses);
  } catch (e) {
    console.error('assessment-retrieve blurb generation failed (non-fatal):', e);
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      patientName: patientName,
      instrumentSet: assessment.instrument_set,
      completedAt: assessment.completed_at,
      scores: scores,
      responses: responses,
      flags: flags,
      blurbs: { screenerReview: screenerReviewBlurb, hpiSymptom: hpiSymptomBlurb }
    })
  };
};

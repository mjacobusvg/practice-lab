// netlify/functions/phi-purge-expired.js
//
// Scheduled daily (see netlify.toml). Physically deletes PHI whose retention window
// has passed, so the clinician's chosen window is the ACTUAL deletion time — the S3
// bucket lifecycle is only a backstop, not the primary clock.
//
//   Letters   — letter_send_log + letter_charges: once expires_at has passed, delete
//               the S3 object (pdf_s3_key) and null the row's PDF fields, set pdf_purged_at.
//               (expires_at is only set when a PDF was actually stored, so rows with no
//               stored copy are never touched.)
//   Assessments — per the published policy, raw responses + patient identifiers are deleted
//               30 days after completion; de-identified summary metadata (deidentified_meta)
//               is kept for the longitudinal trend. Also cleans the patient-name object for
//               assessments that expired without ever being completed.
//
// Safe to run anytime: it only deletes data that is already past its retention window.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (+ SES_AWS_* / LETTERS_S3_BUCKET for S3).

const phiS3 = require('./_lib/phi-s3');

const ASSESSMENT_RAW_TTL_DAYS = 30;

function sbHeaders() {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
}

async function sbGet(url) {
  const r = await fetch(url, { headers: sbHeaders() });
  return r.ok ? await r.json() : [];
}
async function sbPatch(url, body) {
  return fetch(url, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=minimal' }, sbHeaders()), body: JSON.stringify(body) });
}
async function sbDelete(url) {
  return fetch(url, { method: 'DELETE', headers: Object.assign({ Prefer: 'return=minimal' }, sbHeaders()) });
}

// Purge expired stored PDFs from one letter table.
async function purgeLetters(URL, table) {
  let purged = 0;
  const nowIso = new Date().toISOString();
  const rows = await sbGet(URL + '/rest/v1/' + table +
    '?expires_at=lt.' + encodeURIComponent(nowIso) +
    '&pdf_purged_at=is.null&select=id,pdf_s3_key&limit=500');
  for (const row of rows) {
    if (row.pdf_s3_key) await phiS3.deleteObject(row.pdf_s3_key);
    await sbPatch(URL + '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(row.id),
      { pdf_s3_key: null, pdf_base64: null, pdf_purged_at: nowIso });
    purged++;
  }
  return purged;
}

exports.handler = async function () {
  const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  const result = { letters_send_log: 0, letter_charges: 0, assessments_completed: 0, assessments_abandoned: 0 };
  try {
    // ── Letters: delete at the clinician-chosen window ──
    result.letters_send_log = await purgeLetters(URL, 'letter_send_log');
    result.letter_charges = await purgeLetters(URL, 'letter_charges');

    const nowIso = new Date().toISOString();

    // ── Assessments: raw PHI deleted 30 days after completion; de-id metadata kept ──
    const cutoff = new Date(Date.now() - ASSESSMENT_RAW_TTL_DAYS * 86400000).toISOString();
    const completed = await sbGet(URL + '/rest/v1/assessments' +
      '?status=in.(completed,retrieved)&completed_at=lt.' + encodeURIComponent(cutoff) +
      '&purged_at=is.null&select=id,patient_s3_key&limit=500');
    for (const a of completed) {
      const results = await sbGet(URL + '/rest/v1/assessment_results?assessment_id=eq.' + encodeURIComponent(a.id) + '&select=result_s3_key');
      for (const r of results) { if (r.result_s3_key) await phiS3.deleteObject(r.result_s3_key); }
      if (a.patient_s3_key) await phiS3.deleteObject(a.patient_s3_key);
      await sbDelete(URL + '/rest/v1/assessment_results?assessment_id=eq.' + encodeURIComponent(a.id));
      await sbPatch(URL + '/rest/v1/assessments?id=eq.' + encodeURIComponent(a.id),
        { patient_s3_key: null, patient_name: null, purged_at: nowIso });
      result.assessments_completed++;
    }

    // ── Assessments never completed (pending/expired past their link expiry): drop the
    //    stored patient name so no identifier lingers for an assessment that produced no result.
    const abandoned = await sbGet(URL + '/rest/v1/assessments' +
      '?status=in.(pending,expired)&expires_at=lt.' + encodeURIComponent(nowIso) +
      '&patient_s3_key=not.is.null&select=id,patient_s3_key&limit=500');
    for (const a of abandoned) {
      if (a.patient_s3_key) await phiS3.deleteObject(a.patient_s3_key);
      await sbPatch(URL + '/rest/v1/assessments?id=eq.' + encodeURIComponent(a.id),
        { patient_s3_key: null, patient_name: null });
      result.assessments_abandoned++;
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, purged: result }) };
  } catch (err) {
    console.error('phi-purge-expired failed:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message, purged: result }) };
  }
};

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
const lettersPhi = require('./_lib/letters-phi');
const guard = require('./_lib/scheduled-guard');

const ASSESSMENT_RAW_TTL_DAYS = 30;

// A finished (cancelled / opted-out / ended) letter schedule keeps its patient record
// for this long before it is cleared, so a provider who cancels by mistake can still
// see what it was. The old SQL purge used 30 days for patient_email only.
const SCHEDULE_CLOSED_TTL_DAYS = 30;

// A fax delivery webhook never arrives months late; after this the mapping is dead weight.
const FAX_JOB_TTL_DAYS = 90;

function sbHeaders() {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  return { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
}

async function sbGet(url) {
  const r = await fetch(url, { headers: sbHeaders() });
  return r.ok ? await r.json() : [];
}
// Throws on a rejected write. Everything in this file deletes or rewrites PHI, so a
// write that quietly fails is the worst outcome available: the job reports a clean run
// and the data is still there. A NOT NULL constraint on patient_email did exactly that
// for a day. Audit 2026-09-17.
async function sbPatch(url, body) {
  const r = await fetch(url, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=minimal' }, sbHeaders()), body: JSON.stringify(body) });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 200); } catch (e) { detail = '(no body)'; }
    throw new Error('PATCH ' + r.status + ' on ' + url.split('?')[0].split('/rest/v1/')[1] + ': ' + detail);
  }
  return r;
}
async function sbDelete(url) {
  return fetch(url, { method: 'DELETE', headers: Object.assign({ Prefer: 'return=minimal' }, sbHeaders()) });
}

// Adapter: _lib/letters-phi expects patchRow(table, id, patch); this file's sbPatch
// takes a full URL. Bound to SUPABASE_URL inside the handler via purgePatchRow.
function makePatchRow(baseUrl) {
  return function (table, id, patch) {
    return sbPatch(baseUrl + '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id), patch);
  };
}

// Purge expired stored PDFs from one letter table.
async function purgeLetters(URL, table) {
  let purged = 0, failed = 0;
  const nowIso = new Date().toISOString();
  const rows = await sbGet(URL + '/rest/v1/' + table +
    '?expires_at=lt.' + encodeURIComponent(nowIso) +
    '&pdf_purged_at=is.null&select=id,pdf_s3_key&limit=500');
  for (const row of rows) {
   try {
    if (row.pdf_s3_key) await phiS3.deleteObject(row.pdf_s3_key);
    // pdf_filename goes too. The purge used to clear the bytes and the key and leave the
    // NAME behind, and a name is a place PHI hides: rows written before
    // _lib/letters-phi.js safePdfFilename() took over stored whatever the browser sent, and
    // two of the legacy ones carried what reads as a patient surname. Once the PDF is gone
    // the filename describes nothing, and letter-view answers 410 for a purged row before
    // it ever reads this field. Audit 2026-09-16.
    await sbPatch(URL + '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(row.id),
      { pdf_s3_key: null, pdf_base64: null, pdf_filename: null, pdf_purged_at: nowIso });
    purged++;
   } catch (e) {
    // One unpurgeable row must not stop the others; the count of failures reaches the
    // run record, so a persistent problem shows as a failed run rather than a clean one.
    failed++;
    console.error('[phi-purge-expired] purge ' + table + ' ' + row.id + ' failed: ' + (e && e.message));
   }
  }
  return { purged: purged, failed: failed };
}

exports.handler = async function (event) {
  // Gate: this job had no check of any kind, and it DELETES PHI from S3 and nulls
  // columns. Every rule is bounded to data already past its purpose, so the exposure
  // was limited — but an unauthenticated destructive endpoint on a PHI store should not
  // exist, and the letters heal sweep added more for it to do. See _lib/scheduled-guard.js.
  const auth = guard.authorize(event, { name: 'phi-purge-expired', secrets: [process.env.BACKFILL_SECRET] });
  if (!auth.ok) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  const claim = await guard.claimRun('phi-purge-expired', 12 * 60 * 60 * 1000, auth.via);
  if (!claim.claimed) return { statusCode: 429, body: JSON.stringify({ skipped: 'ran too recently', last_run_at: claim.lastRunAt }) };

  const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  const purgePatchRow = makePatchRow(URL);

  // sbPatch throws on a rejected write so nothing fails silently any more. But one bad
  // row must not stop the rest: this job deletes PHI, and aborting halfway would leave
  // later rules unrun. So each row is attempted independently, failures are counted, and
  // the run is marked NOT ok if any occurred — loud, complete, and honest at once.
  async function attempt(label, fn) {
    try { await fn(); return true; }
    catch (e) {
      result.failures++;
      console.error('[phi-purge-expired] ' + label + ' failed: ' + (e && e.message));
      return false;
    }
  }
  const result = { letters_send_log: 0, letter_charges: 0, schedules_healed: 0, charges_healed: 0,
                   schedules_closed: 0, charges_released: 0, fax_jobs_purged: 0, failures: 0,
                   assessments_completed: 0, assessments_abandoned: 0 };
  try {
    // ── Letters: delete at the clinician-chosen window ──
    const sendLogPurge = await purgeLetters(URL, 'letter_send_log');
    const chargePurge = await purgeLetters(URL, 'letter_charges');
    result.letters_send_log = sendLogPurge.purged;
    result.letter_charges = chargePurge.purged;
    result.failures += sendLogPurge.failed + chargePurge.failed;

    const nowIso = new Date().toISOString();

    // ── Heal sweep: migrate any letter row still holding PHI inline ──
    // The read paths self-heal, but only when something reads them. An active schedule
    // on a long cadence may not run for weeks (the live one is 25 days out), and a
    // provider may not open the Letter Generator. That would leave a real patient
    // address sitting in Supabase for the whole window, which is the thing this
    // migration exists to stop. Sweeping here bounds it to 24 hours regardless of
    // traffic. Idempotent: rows that already carry a key are skipped by the filter.
    const unhealed = await sbGet(URL + '/rest/v1/letter_schedules' +
      '?patient_s3_key=is.null' +
      '&or=(patient_email.not.is.null,patient_label.not.is.null,' +
      'patient_message.not.is.null,first_message.not.is.null)' +
      '&select=id,patient_email,patient_label,patient_message,first_message&limit=500');
    for (const s of unhealed) {
      const key = await lettersPhi.healSchedule(purgePatchRow, s);
      if (key) result.schedules_healed++;
    }

    const unhealedCharges = await sbGet(URL + '/rest/v1/letter_charges' +
      '?patient_s3_key=is.null&patient_email=not.is.null&select=id,patient_email&limit=500');
    for (const c of unhealedCharges) {
      const key = await lettersPhi.healCharge(purgePatchRow, c);
      if (key) result.charges_healed++;
    }

    // ── Letter schedules that are finished: drop the patient record entirely ──
    // A cancelled / opted-out / ended schedule will never send again, so its patient
    // address, label and provider-authored messages have no further purpose. The old
    // SQL purge only nulled patient_email and only after 30 days, which left labels
    // sitting there indefinitely. This clears the S3 object AND every inline column,
    // which is also how the two pre-migration cancelled rows get cleaned up: they will
    // never be read by the cron, so they can never self-heal. Audit 2026-09-16.
    const closedCutoff = new Date(Date.now() - SCHEDULE_CLOSED_TTL_DAYS * 86400000).toISOString();
    const closed = await sbGet(URL + '/rest/v1/letter_schedules' +
      '?status=in.(cancelled,opted_out,ended)&updated_at=lt.' + encodeURIComponent(closedCutoff) +
      '&or=(patient_s3_key.not.is.null,patient_email.not.is.null,patient_label.not.is.null,' +
      'patient_message.not.is.null,first_message.not.is.null)' +
      '&select=id,patient_s3_key&limit=500');
    for (const s of closed) {
      await attempt('close schedule ' + s.id, async () => {
        if (s.patient_s3_key) await phiS3.deleteObject(s.patient_s3_key);
        await sbPatch(URL + '/rest/v1/letter_schedules?id=eq.' + encodeURIComponent(s.id), {
          patient_s3_key: null, patient_email: null, patient_label: null,
          patient_message: null, first_message: null, updated_at: nowIso
        });
        result.schedules_closed++;
      });
    }

    // ── Paid letter charges: the pay link has already been emailed ──
    // letter-charge-webhook.js clears the address inline as soon as it sends, so this
    // only catches charges paid before that shipped, plus any webhook whose cleanup
    // failed. The PDF itself is governed separately by expires_at above.
    const releasedCharges = await sbGet(URL + '/rest/v1/letter_charges' +
      '?status=eq.paid&or=(patient_s3_key.not.is.null,patient_email.not.is.null)' +
      '&select=id,patient_s3_key&limit=500');
    for (const c of releasedCharges) {
      await attempt('release charge ' + c.id, async () => {
        if (c.patient_s3_key) await phiS3.deleteObject(c.patient_s3_key);
        await sbPatch(URL + '/rest/v1/letter_charges?id=eq.' + encodeURIComponent(c.id),
          { patient_s3_key: null, patient_email: null });
        result.charges_released++;
      });
    }

    // ── Fax send records: correlation only, and only for as long as that is useful ──
    // fax_jobs maps a provider fax id to the clinician who sent it, so fax-webhook.js can
    // decide who to notify without trusting the Reference string in the webhook payload.
    // It holds no patient PHI (clinician email plus the last four digits of the number),
    // but a delivery webhook never arrives 90 days late, so keeping them past that is
    // storage without a purpose. Added with the table, so it never becomes an unbounded
    // store somebody finds later. Audit 2026-09-17.
    const faxCutoff = new Date(Date.now() - FAX_JOB_TTL_DAYS * 86400000).toISOString();
    const staleFax = await sbGet(URL + '/rest/v1/fax_jobs?created_at=lt.' + encodeURIComponent(faxCutoff) + '&select=fax_id&limit=500');
    for (const f of staleFax) {
      await attempt('purge fax_jobs ' + f.fax_id, async () => {
        await sbDelete(URL + '/rest/v1/fax_jobs?fax_id=eq.' + encodeURIComponent(f.fax_id));
        result.fax_jobs_purged++;
      });
    }

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
      await attempt('purge abandoned assessment ' + a.id, async () => {
        if (a.patient_s3_key) await phiS3.deleteObject(a.patient_s3_key);
        await sbPatch(URL + '/rest/v1/assessments?id=eq.' + encodeURIComponent(a.id),
          { patient_s3_key: null, patient_name: null });
        result.assessments_abandoned++;
      });
    }

    // Close the run record so "did last night's purge actually run, and did it work?"
    // is answerable from function_run_log instead of trawling Netlify logs.
    const cleanRun = result.failures === 0;
    await guard.finishRun(claim.runId, cleanRun, result,
      cleanRun ? null : result.failures + ' row operation(s) failed — see logs');
    return { statusCode: cleanRun ? 200 : 500, body: JSON.stringify({ ok: cleanRun, purged: result }) };
  } catch (err) {
    console.error('phi-purge-expired failed:', err);
    await guard.finishRun(claim.runId, false, result, err && err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message, purged: result }) };
  }
};

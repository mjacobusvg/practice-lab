// netlify/functions/_lib/letters-phi.js
//
// Patient PHI for the Letter Generator lives in S3 (tbp-letters, AWS BAA) and NOT in
// Supabase, which has no BAA. The 2026-09-09 letters migration moved only the PDF
// bytes; the fields wrapped around them — who the letter is for, what was said to
// them — stayed inline. This module is the one place that knows how to read and write
// them, so the five call sites stay small and can't drift apart the way the columns
// and the state doc did. Security audit 2026-09-16, Tier 2.
//
// Shape stored per table:
//   letter_schedules -> { patient_email, patient_label, patient_message, first_message }
//   letter_charges   -> { patient_email }
//
// Reads are LEGACY-TOLERANT: a row written before this migration still has its inline
// columns, so readSchedulePhi/readChargePhi fall back to them. Callers that can write
// should then call healSchedule/healCharge, which moves the row to S3 and nulls the
// inline columns — pre-migration rows migrate themselves the next time they are used.

var phiS3 = require('./phi-s3');

var SCHEDULE_PREFIX = 'letters/schedule';
var CHARGE_PREFIX = 'letters/charge';

// Fields that carry patient PHI on each table. Anything added here must also be added
// to the null-out in the heal functions, or the row keeps a copy in Supabase.
var SCHEDULE_PHI_FIELDS = ['patient_email', 'patient_label', 'patient_message', 'first_message'];
var CHARGE_PHI_FIELDS = ['patient_email'];

function pick(row, fields) {
  var out = {};
  for (var i = 0; i < fields.length; i++) {
    var v = row ? row[fields[i]] : null;
    // '[purged]' is the sentinel the old SQL purge wrote over patient_email. Treat it
    // as absent so it is never carried forward into S3.
    if (v != null && v !== '' && v !== '[purged]') out[fields[i]] = v;
  }
  return out;
}

function nulls(fields) {
  var out = {};
  for (var i = 0; i < fields.length; i++) out[fields[i]] = null;
  return out;
}

// ── Write (new rows) ────────────────────────────────────────────────────────
// Throws on failure so the caller can refuse to proceed rather than silently
// falling back to writing PHI into Supabase — same contract as _lib/letters-s3.js.
async function putSchedulePhi(obj) { return phiS3.putJson(SCHEDULE_PREFIX, pick(obj, SCHEDULE_PHI_FIELDS)); }
async function putChargePhi(obj) { return phiS3.putJson(CHARGE_PREFIX, pick(obj, CHARGE_PHI_FIELDS)); }

// ── Read (S3 first, inline fallback for pre-migration rows) ─────────────────
async function readSchedulePhi(row) {
  if (row && row.patient_s3_key) {
    var blob = await phiS3.getJson(row.patient_s3_key);
    // getJson returns {} when the object is already purged; fall through to inline
    // rather than returning an empty record that would look like "no patient".
    if (blob && Object.keys(blob).length) return blob;
  }
  return pick(row, SCHEDULE_PHI_FIELDS);
}
async function readChargePhi(row) {
  if (row && row.patient_s3_key) {
    var blob = await phiS3.getJson(row.patient_s3_key);
    if (blob && Object.keys(blob).length) return blob;
  }
  return pick(row, CHARGE_PHI_FIELDS);
}

// ── Self-heal (move a pre-migration row to S3 on first use) ─────────────────
// Best-effort by design: a heal failure must never break the send or the page that
// triggered it. The row simply stays on the legacy path and is retried next time.
// Returns the new key, or null if nothing needed doing / it failed.
async function healRow(sbPatch, table, row, prefix, fields) {
  try {
    if (!row || row.patient_s3_key) return null;
    var phi = pick(row, fields);
    if (!Object.keys(phi).length) return null;       // nothing inline worth moving
    var key = await phiS3.putJson(prefix, phi);
    // The PATCH result is CHECKED. It used to be awaited and ignored, so when the write
    // was rejected this still returned the key and phi-purge-expired counted a heal that
    // had not happened — it reported schedules_healed: 3 against rows whose updated_at
    // had not moved since July. A migration that cannot fail visibly is a migration you
    // cannot trust, and it hid a NOT NULL constraint on patient_email for a full day.
    var res = await sbPatch(table, row.id, Object.assign({ patient_s3_key: key }, nulls(fields)));
    if (res && res.ok === false) {
      var detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (e) { detail = '(no body)'; }
      throw new Error('patch rejected ' + res.status + ': ' + detail);
    }
    return key;
  } catch (e) {
    console.log('[letters-phi] heal failed for ' + table + ' ' + (row && row.id) + ':', e && e.message);
    return null;
  }
}
async function healSchedule(sbPatch, row) { return healRow(sbPatch, 'letter_schedules', row, SCHEDULE_PREFIX, SCHEDULE_PHI_FIELDS); }
async function healCharge(sbPatch, row) { return healRow(sbPatch, 'letter_charges', row, CHARGE_PREFIX, CHARGE_PHI_FIELDS); }

// ── Filenames ───────────────────────────────────────────────────────────────
// pdf_filename was whatever the browser sent, up to 160 chars, and is echoed back in
// Content-Disposition. A patient name in a filename is PHI at rest here and on the
// recipient's device, so the name is derived server-side from the letter TYPE (a
// category label, never patient-identifying).
function safePdfFilename(letterType) {
  var slug = String(letterType || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return (slug || 'letter') + '.pdf';
}

module.exports = {
  putSchedulePhi: putSchedulePhi,
  putChargePhi: putChargePhi,
  readSchedulePhi: readSchedulePhi,
  readChargePhi: readChargePhi,
  healSchedule: healSchedule,
  healCharge: healCharge,
  safePdfFilename: safePdfFilename,
  SCHEDULE_PHI_FIELDS: SCHEDULE_PHI_FIELDS,
  CHARGE_PHI_FIELDS: CHARGE_PHI_FIELDS
};

// netlify/functions/_lib/assessments-phi-gate.js
//
// TEMPORARY compliance guard. Assessment PHI (patient name, responses/scores,
// and the patient email held for recurring sends) currently persists in Supabase,
// which has NO BAA. Per HHS, a cloud service that receives/maintains/transmits
// ePHI is a Business Associate even if the data is encrypted or transient — so
// "brief then purged" is not sufficient. Until assessment PHI storage is migrated
// to S3 under the AWS BAA (mirroring the letters migration), we PAUSE the
// assessment send/intake paths so no NEW PHI can be written to Supabase.
//
// Flip PAUSED to false in the same change that moves assessment PHI to S3.
var PAUSED = true;

// Clinician-facing copy (create / schedule). Patient-facing submit uses its own
// neutral GENERIC_UNAVAILABLE string; autosend just no-ops.
var MESSAGE = 'The Assessment Suite is briefly paused for a storage upgrade. It will be back shortly — thanks for your patience.';

module.exports = { PAUSED: PAUSED, MESSAGE: MESSAGE };

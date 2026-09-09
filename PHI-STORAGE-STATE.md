# PHI-at-rest state — what actually persists, where (verified)

**Purpose:** a **verified** inventory of every place patient PHI can come to rest, checked against
the live code AND the live database — not memory, not the design intent. Written because the
"nothing is stored / it's all on AWS" mental model had drifted from reality, and a prospective
member's compliance review (Elijah, 2026-09) surfaced it. Pairs with `BAA-AND-PHI-ROUTING.md`
(which describes the *intended* routing); THIS file records the *actual* at-rest reality.

**Verified:** 2026-09-09, against project `ubcrrrapedaxkguxniwv` ("Ask the Archive" = the live
platform DB) and the code on `main`. Re-verify (counts + code paths) before making any written
PHI-retention representation to a member or in policy.

---

## The short version

- **Transient, nothing stored (clean):** note writer / audit-coder / HPI / de-identify (Bedrock,
  streamed), ambient audio (Azure, deleted post-transcription), OCR (Textract, synchronous).
  Only token-COUNT metadata hits Supabase `tool_usage` (never content).
- **Letters — MOVED TO AWS S3 (2026-09-09, verified end-to-end).** Letter PDFs now store in S3
  bucket `tbp-letters` (us-east-1) under the AWS BAA; the DB keeps only `pdf_s3_key`. Verified: a
  new paid letter row has `pdf_s3_key` set, `pdf_base64` null, and `letter-view` served it from S3.
  Legacy pre-migration rows may still hold inline `pdf_base64` until they expire (served via a
  fallback). See "Letters" row below.
- **Assessments — MIGRATED TO AWS S3 (2026-09-09).** Patient name, responses/scores/flags, and the
  recurring-schedule patient email now store in S3 (`tbp-letters` bucket, `assessments/` prefix, AWS
  BAA) via `_lib/phi-s3.js`; Supabase keeps only S3 keys (`patient_s3_key`, `result_s3_key`) plus
  non-PHI fields (token, status, instrument_set, `patient_hash`, `deidentified_meta`). All six
  functions updated (create, submit, retrieve, list, schedule, autosend-run) with legacy fallback
  for any pre-migration row. The intake pause is lifted (`_lib/assessments-phi-gate.js` `PAUSED=false`,
  kept as a kill-switch). Verify end-to-end before treating as fully done.
- **Certified mail** — `certified_mail_jobs` (columns `letter_text`, `to_name`, `to_address`) is a
  not-enabled stub, 0 rows. Its write path (`create-certified-checkout`) is now blocked
  **unconditionally** until `letter_text` moves to S3 AND a mail-vendor BAA is executed.

## Verified live counts (2026-09-09)

| Table | What it can hold | Live PHI right now |
|---|---|---|
| `letter_send_log` | delivery meta (subject, masked recipient) + optional `pdf_base64` | **11 rows; 1 stored PDF unpurged**; all 11 have a `subject` |
| `assessments` | `patient_name`, `patient_hash`, `deidentified_meta` | 2 rows, **both purged, 0 patient names** |
| `assessment_results` | `responses`, `scores`, `flags` | **0 rows** |
| `tool_usage` | token counts, tool label, member email | metadata only (no content) — clean |

So today the only patient PHI actually at rest in Supabase is **1 letter PDF** (+ 11 letter
subject lines, which may or may not contain identifiers — verify how `getLetterSubject()` builds
them). Assessments are currently clean.

## Feature-by-feature retention (verified)

| Feature | Path | At rest? | Retention |
|---|---|---|---|
| Note writer / Audit-Coder / HPI / de-id | Browser → AWS Lambda → Bedrock (US) | **No** | none (token counts only) |
| Ambient audio | Azure Blob (US) → Azure AI Speech | No | deleted immediately after transcription |
| Transcription resume | browser holds job-id pointer only | No PHI | pointer self-expires ~30 min |
| Local note draft | clinician's browser localStorage | on device only | auto-purged after 18h |
| Scanned-record OCR | AWS Textract (synchronous) | No | none |
| **Letter generator** | delivered via SES; PDF in **AWS S3** (`tbp-letters`, AWS BAA) | **PDF in S3, not Supabase**; DB keeps only `pdf_s3_key` + subject/masked-recipient metadata | PDF: clinician-chosen, default 14d / max 90d (app-gated by `expires_at`; S3 90d lifecycle backstop); served by `letter-view.js` from S3, legacy inline fallback |
| **Assessments** | PHI in **AWS S3** (`assessments/` prefix, AWS BAA); AI scoring via Bedrock | **name/responses/scores + schedule email in S3, not Supabase**; DB keeps keys + de-id metadata | S3-stored; purged on clinician delete; de-id metadata retained in Supabase |
| Notifications / email delivery | Amazon SES (AWS BAA) | in transit only | n/a |

## The gap vs. what we tell members — RESOLVED for letters

"Supabase is not in the PHI path" is now true for the scribe/tools, for letters (PDFs in S3 as of
2026-09-09), and for assessments (transient, purged). The letter PDF divergence that this file was
created to flag has been fixed: letter content lives in S3 under the AWS BAA, the DB holds only a
key. **Remaining:**
- **Legacy letter rows** created before 2026-09-09 may still hold inline `pdf_base64` in Supabase
  until they hit their `expires_at`/purge (letter-view serves them via a fallback). Small count;
  let them expire, or migrate/purge if a fully-clean Supabase is needed immediately.
- **Assessments** are now migrated to S3 (AWS BAA) and re-enabled — patient name, responses, and
  schedule patient email store in S3, Supabase keeps only keys + de-identified metadata.
- **Per-expiry deletion — DONE (2026-09-09).** `phi-purge-expired.js` (Netlify scheduled fn, daily
  `0 8 * * *`) physically deletes the S3 object at each letter's chosen `expires_at` (the
  0/7/14/30/90 window), so the clinician's window is the real deletion time; the 90-day S3 lifecycle
  is now only a backstop. Same job deletes raw assessment PHI 30 days after completion (keeping
  `deidentified_meta` for the longitudinal trend) and cleans the patient-name object for assessments
  that expired without completion. Letter `0` = "don't store" is enforced in `letter-log.js` too.

## Decision log

- **2026-09-09:** verified the above; letter PDF storage identified as the one live divergence from
  "Supabase not in the PHI path."
- **2026-09-09 (same day):** RESOLVED — letter PDFs moved to AWS S3 (`tbp-letters`, us-east-1, AWS
  BAA); `pdf_s3_key` column added to `letter_send_log` + `letter_charges`; verified end-to-end with
  a real paid letter (row `paid`, `pdf_s3_key` set, `pdf_base64` null, served from S3). Legacy rows
  keep working via inline fallback and expire on their own.
- **2026-09-09 (same day):** assessment + certified-mail PHI writes to Supabase first PAUSED, then
  assessment PHI MIGRATED to S3 (AWS BAA) via `_lib/phi-s3.js` across create/submit/retrieve/list/
  schedule/autosend, and the pause lifted (`PAUSED=false`, kept as kill-switch). Supabase now holds
  only S3 keys + de-identified metadata for assessments. Certified mail stays blocked
  unconditionally (stub; move `letter_text` to S3 + execute a mail-vendor BAA before enabling).
  **Verify end-to-end** (send → patient submit → clinician retrieve) before treating as closed.

## Also holds member/business data (PII, not PHI — no BAA needed)

`accounts`, `contacts`, `subscriptions`, `baa_signatures`, consent records — clinician/customer
info, not patient PHI. Correctly in Supabase.

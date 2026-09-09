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
- **Assessments** — `assessments.patient_name` + `assessment_results.responses` transit Supabase
  between patient-submit and provider-retrieve, then purge. Encrypted at rest, auto-purged.
  Currently 0 live PHI. (Not yet moved to AWS; transient-purge design is disclosable as-is.)

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
| **Assessments** | patient form → Supabase; AI scoring via Bedrock | **patient_name + responses in Supabase, transiently** | purged after provider retrieval (`purged_at`); de-id metadata kept |
| Notifications / email delivery | Amazon SES (AWS BAA) | in transit only | n/a |

## The gap vs. what we tell members — RESOLVED for letters

"Supabase is not in the PHI path" is now true for the scribe/tools, for letters (PDFs in S3 as of
2026-09-09), and for assessments (transient, purged). The letter PDF divergence that this file was
created to flag has been fixed: letter content lives in S3 under the AWS BAA, the DB holds only a
key. **Remaining:**
- **Legacy letter rows** created before 2026-09-09 may still hold inline `pdf_base64` in Supabase
  until they hit their `expires_at`/purge (letter-view serves them via a fallback). Small count;
  let them expire, or migrate/purge if a fully-clean Supabase is needed immediately.
- **Assessments** are not moved to AWS — the transient-purge design keeps them clean in practice
  (0 live PHI) and is disclosable as-is. A full S3 move is only worth it if recurring/longitudinal
  patient assessments become a core feature.
- **Optional refinement:** the S3 object is app-gated after `expires_at` and auto-deleted by the
  bucket's 90-day lifecycle, but not physically deleted at each letter's exact chosen expiry. A
  small scheduled cleanup (delete S3 objects past `expires_at`) would tighten that — not urgent.

## Decision log

- **2026-09-09:** verified the above; letter PDF storage identified as the one live divergence from
  "Supabase not in the PHI path."
- **2026-09-09 (same day):** RESOLVED — letter PDFs moved to AWS S3 (`tbp-letters`, us-east-1, AWS
  BAA); `pdf_s3_key` column added to `letter_send_log` + `letter_charges`; verified end-to-end with
  a real paid letter (row `paid`, `pdf_s3_key` set, `pdf_base64` null, served from S3). Legacy rows
  keep working via inline fallback and expire on their own.

## Also holds member/business data (PII, not PHI — no BAA needed)

`accounts`, `contacts`, `subscriptions`, `baa_signatures`, consent records — clinician/customer
info, not patient PHI. Correctly in Supabase.

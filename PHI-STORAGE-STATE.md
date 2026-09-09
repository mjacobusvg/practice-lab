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
- **PHI CAN rest in Supabase (no BAA) — the real items:**
  - **Letters** — `letter_send_log` (+ `create-letter-charge` for paid letters) stores the full
    letter **PDF** when the clinician chooses retention. **This is a live feature, not dead data:**
    `letter-view.js` serves the stored PDF back as a "view the sent letter" link.
  - **Assessments** — `assessments.patient_name` + `assessment_results.responses` transit Supabase
    between patient-submit and provider-retrieve, then purge. Encrypted at rest, auto-purged.

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
| **Letter generator** | delivered via SES; log in Supabase | **subject + optional PDF in Supabase** | PDF: clinician-chosen, default 14d / max 90d, then `pdf_purged_at`; served by `letter-view.js` |
| **Assessments** | patient form → Supabase; AI scoring via Bedrock | **patient_name + responses in Supabase, transiently** | purged after provider retrieval (`purged_at`); de-id metadata kept |
| Notifications / email delivery | Amazon SES (AWS BAA) | in transit only | n/a |

## The gap vs. what we tell members

We tell compliance reviewers "Supabase is not in the PHI path." That is true for the scribe and
its tools, and currently true for assessments (purged), but **the letter PDF-retention feature
puts letter content (PHI) in Supabase, which has no BAA.** To make the statement strictly true,
one of:

1. **Move letter PDFs to AWS S3** (under the existing AWS BAA) — the correct long-term fix.
   Touches `letter-log.js`, `create-letter-charge.js`, `letter-view.js` (serve from S3 via signed
   URL), plus migrating/expiring existing rows. Requires an S3 bucket + IAM on AWS account
   `266359797908` (owner provisions). **Medium project — not a toggle**, because `letter-view`
   depends on the stored PDF.
2. **Disable PDF retention** — letters become delivery-metadata-only; drops the "view sent letter"
   link. Small code change, loses a feature.
3. **Disclose accurately** — "letter PDFs retained only if you choose, ≤90 days, encrypted, then
   auto-purged," and keep the feature. No code change; requires the honest wording in replies/policy.

Assessments: full move to AWS is a larger, separate project (rework intake + retrieve); only worth
it if recurring/longitudinal patient assessments become a real feature. Current transient-purge
design is disclosable as-is.

## Decision log

- **2026-09-09:** verified the above; letter PDF storage identified as the one live divergence from
  "Supabase not in the PHI path." Awaiting owner decision between options 1/2/3. No changes made to
  the storage paths yet.

## Also holds member/business data (PII, not PHI — no BAA needed)

`accounts`, `contacts`, `subscriptions`, `baa_signatures`, consent records — clinician/customer
info, not patient PHI. Correctly in Supabase.

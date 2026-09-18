# PHI-at-rest state — what actually persists, where (verified)

**Purpose:** a **verified** inventory of every place patient PHI can come to rest, checked against
the live code AND the live database — not memory, not the design intent. Written because the
"nothing is stored / it's all on AWS" mental model had drifted from reality, and a prospective
member's compliance review (Elijah, 2026-09) surfaced it. Pairs with `BAA-AND-PHI-ROUTING.md`
(which describes the *intended* routing); THIS file records the *actual* at-rest reality.

**Verified:** 2026-09-09, then **re-verified 2026-09-16** (security audit) against project
`ubcrrrapedaxkguxniwv` ("Ask the Archive" = the live platform DB) and the code on `main`.
Re-verify (counts + code paths) before making any written PHI-retention representation to a
member or in policy.

**Since 2026-09-16 this file is no longer the only thing looking.** `phi-drift-check.js` (Netlify
scheduled fn, daily 08:30 UTC) counts every PHI-capable column listed here and emails if any goes
non-zero. It exists because the 2026-09-09 table below was verified, published as "zero inline PHI
at rest", and was **wrong within a week** — `letter_schedules` had been carrying `patient_email`,
`patient_label`, `patient_message` and `first_message` the entire time, because that table was
never in the inventory it was checked against. A hand-verified inventory is only as good as its
list of what to look at, and nothing was re-checking the list.

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
- **Letter SCHEDULES and CHARGES — the 2026-09-09 gap (found 2026-09-16, code fixed, data pending).**
  The 09-09 migration moved the letter *PDF* to S3 and stopped. It did not move the patient fields
  on the recurring-schedule and pay-link rows: `letter_schedules.patient_email`, `.patient_label`,
  `.patient_message`, `.first_message` and `letter_charges.patient_email`. Those are a patient's
  address, the clinician's label for them, and provider-authored messages about them — sitting in
  Supabase, off the AWS BAA. The write and read paths now go through `_lib/letters-phi.js` to S3
  (`letter-schedule.js`, `letter-autosend-cron.js`, `create-letter-charge.js`,
  `letter-charge-webhook.js`), and `phi-purge-expired.js` gained a daily heal sweep for rows no read
  path will reach. **The existing rows are not migrated yet** — see the counts below.
- **Signed BAAs — bucket was PUBLIC until 2026-09-16.** Not patient PHI, but 49 executed agreements
  (signer legal name, entity, title, email, signing IP) sat in a public Supabase Storage bucket at a
  path derived from the signer's email address. Bucket is now private; retrieval goes through
  `baa-document.js` against a verified session or an expiring single-document token.

## Verified live counts (re-verified 2026-09-16)

Counted by direct query against the live DB. **This is not clean.** The table after it is the
2026-09-09 claim, kept because being able to see what a verified inventory asserted — and where it
was wrong — is the reason `phi-drift-check.js` now exists.

| Column checked | Live PHI (2026-09-16) | Note |
|---|---|---|
| `letter_schedules.patient_email` | **0** (was 3 of 3) | migrated to S3 2026-09-18 |
| `letter_schedules.patient_label` | **0** (was 3 of 3) | migrated to S3 2026-09-18 |
| `letter_schedules.patient_message` | **0** (was 1 of 3) | migrated to S3 2026-09-18 |
| `letter_schedules.first_message` | **0** (was 1 of 3) | migrated to S3 2026-09-18 |
| `letter_schedules.patient_s3_key` | **3 of 3 rows** | all three now point at S3 under the AWS BAA |
| `letter_charges.patient_email` | **0** (was 1 of 1) | healed and released by the 08:00 purge on 2026-09-18; both columns now null |
| `letter_schedules.last_error` | 0 of 3 rows | watched: an SES failure string can echo a patient address |
| `letter_charges.pdf_base64` | 0 | holds as of 09-09 |
| `letter_send_log.pdf_base64` | 0 | holds |
| `assessments.patient_name` | 0 | holds |
| `assessment_results.responses` / `scores` / `flags` | 0 | holds |
| `assessment_schedules.patient_email` / `.patient_label` | 0 (0 rows) | holds |
| `certified_mail_jobs.letter_text` / `to_name` / `to_address` | 0 (0 rows) | stub, write path blocked |
| `letter_send_log.recipient_masked` not masked | 0 of 11 non-null | all `@domain.tld` or `••••1234`; watched because the masking happens client-side |
| `pdf_filename` not derived from letter type | 0 (was 4, fixed 2026-09-16) | the 4 legacy browser-supplied names were rewritten to their letter-type slug; two of them read as a patient surname |
| `tool_usage` | token/metadata only | holds |

Between them these rows cover all 20 automated checks — the 17 `COUNT_CHECKS` and 3 `SHAPE_CHECKS`
in `phi-drift-check.js` — with some rows grouping sibling columns (the three assessment-result
columns, the two assessment-schedule columns, the three certified-mail columns, and `pdf_filename`
across two tables). `patient_s3_key` and `tool_usage` are here for context and are not checks.
Keep the two in step: a column added to one and not the other is how the 09-09 inventory went stale
in the first place.

The four `letter_schedules` / `letter_charges` rows are what the daily heal sweep in
`phi-purge-expired.js` (08:00 UTC) exists to clear.

`pdf_filename` is **resolved**: both writers already generated it from the letter type
(`safePdfFilename()`), but the purge cleared the bytes and the key and *left the name behind* —
so three already-purged rows were still holding a browser-supplied string, two of which read as a
patient surname. The purge now nulls `pdf_filename` too, and the four legacy values were rewritten
in place to their letter-type slug. Rewritten, not exempted in the drift check: silencing the alarm
for the first thing it caught would defeat building it.

### Superseded: the 2026-09-09 claim (wrong — kept as the record)

Verified by direct query after moving letters/assessments to S3 and deleting the legacy
test rows — **zero inline PHI at rest in Supabase across every PHI-capable column:**

| Column checked | Live PHI now |
|---|---|
| `letter_charges.pdf_base64` | **0** (legacy test rows deleted; new letters store `pdf_s3_key` → S3) |
| `letter_send_log.pdf_base64` | **0** (same) |
| `assessments.patient_name` | **0** (name now in S3 via `patient_s3_key`) |
| `assessment_results.responses` / `scores` | **0** (now in S3 via `result_s3_key`) |
| `assessment_schedules.patient_email` | **0** (now in S3 via `patient_s3_key`) |
| `certified_mail_jobs.letter_text` | **0** (stub, write path blocked) |
| `tool_usage` | token/metadata only (no content) — clean |

PHI now lives only in **S3 under the AWS BAA** (letter PDFs, assessment name/responses,
schedule email) or is transient (scribe/audit/transcription/OCR). Nothing patient-identifying
rests in Supabase. Re-run these counts before any future compliance representation.

> **The last two sentences above were false when written.** The table never listed
> `letter_schedules` or `letter_charges` patient fields, so "every PHI-capable column" meant every
> column someone thought to check. Patient addresses and provider-authored messages about patients
> were resting in Supabase the whole time. Do not quote the 09-09 table; use the 09-16 one, and
> confirm against the latest `phi-drift-check` run in `function_run_log` before any representation.

## Feature-by-feature retention (verified)

| Feature | Path | At rest? | Retention |
|---|---|---|---|
| Note writer / Audit-Coder / HPI / de-id | Browser → AWS Lambda → Bedrock (US) | **No** | none (token counts only) |
| Ambient audio | Azure Blob (US) → Azure AI Speech | No | deleted immediately after transcription |
| Transcription resume | browser holds job-id pointer only | No PHI | pointer self-expires ~30 min |
| Local note draft | clinician's browser localStorage | on device only | auto-purged after 18h |
| Scanned-record OCR | AWS Textract (synchronous) | No | none |
| **Letter generator** | delivered via SES; PDF in **AWS S3** (`tbp-letters`, AWS BAA) | **PDF in S3, not Supabase**; DB keeps only `pdf_s3_key` + subject/masked-recipient metadata | PDF: clinician-chosen, default 14d / max 90d (app-gated by `expires_at`; S3 90d lifecycle backstop); served by `letter-view.js` from S3, legacy inline fallback |
| **Assessments** | PHI in **AWS S3** (`assessments/` prefix, AWS BAA); AI scoring via Bedrock | **name/responses/scores + schedule email in S3, not Supabase**; DB keeps keys + de-id metadata | raw PHI auto-deleted 30 days after completion (`phi-purge-expired.js`) or on clinician delete; de-id metadata retained in Supabase for trends |
| **Letter schedules** (recurring sends) | patient fields in **AWS S3** via `_lib/letters-phi.js`; row keeps `patient_s3_key` | **address, label and provider-authored messages in S3** for new rows; pre-2026-09-16 rows still inline until the heal sweep | cleared 30 days after a schedule is cancelled / opted-out / ended (`SCHEDULE_CLOSED_TTL_DAYS`) |
| **Letter charges** (pay links) | patient address in **AWS S3**; row keeps `patient_s3_key` | same | cleared by `letter-charge-webhook.js` on send, backstopped by the daily purge |
| Notifications / email delivery | Amazon SES (AWS BAA) | in transit only | n/a |

## The gap vs. what we tell members — letters RESOLVED in code, data pending

"Supabase is not in the PHI path" is now true for the scribe/tools, for letters (PDFs in S3 as of
2026-09-09), and for assessments (transient, purged). The letter PDF divergence that this file was
created to flag has been fixed: letter content lives in S3 under the AWS BAA, the DB holds only a
key.

**It is NOT yet true without qualification.** As of 2026-09-16 there are live rows holding a
patient's email address, the clinician's label for them, and provider-authored messages about them
(counts above). The code no longer writes them, and the daily sweep will clear them, but until
`phi-drift-check` reports clean, the honest statement to a member is "letter content and assessment
PHI are in S3 under the AWS BAA; a small number of legacy schedule rows are being migrated," not
"nothing patient-identifying rests in Supabase."

**Remaining:**
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

- **2026-09-16 (security audit):** a full production audit re-checked this file against the DB and
  found the 09-09 inventory incomplete. Changes, all on `main`:
  - **Letter schedule / charge patient fields moved to S3** (`_lib/letters-phi.js`, used by
    `letter-schedule.js`, `letter-autosend-cron.js`, `create-letter-charge.js`,
    `letter-charge-webhook.js`, `letter-log.js`). Read paths self-heal a legacy row on access;
    `phi-purge-expired.js` gained a **daily heal sweep** for rows no read path reaches (an active
    schedule on a long cadence may not run for weeks), plus a 30-day purge of finished schedules
    and an address purge for paid charges. **Data migration still pending its first 08:00 UTC run.**
  - **`phi-drift-check.js` added** (daily 08:30 UTC): counts 17 columns that must be NULL plus 3
    shape checks (recipient masking, PDF filenames), and emails when the failing set changes,
    clears, or stays broken a week. Counts only — an alert never carries a PHI value. This file is
    its specification; **add a column here and add it there too.**
  - **`baa-documents` Storage bucket flipped to private**; retrieval via `baa-document.js` with a
    verified session or an expiring single-document token. New objects store at a random path
    rather than one derived from the signer's email.
  - Also closed, outside this file's scope: public-readable RLS on `accounts` / `user_tool_data` /
    `providers` / `email_log` (exploitable as `anon` for ~4 months), an ungated `anthropic-proxy`,
    unauthenticated template uploads, a client error sink that accepted note text, gates on the
    scheduled jobs, the `AUTOSEND_SECRET` rotation into Supabase Vault, and a fail-OPEN BAA check
    that let a database blip open the PHI gate for everyone.
  - **Correction to the audit's own record:** scheduled Netlify functions turned out NOT to be
    HTTP-reachable (403, empty body, before the handler runs), so the forged-`next_run` finding was
    theoretical on this deployment, not live. See `_lib/scheduled-guard.js`.

- **2026-09-17:** the letters migration recorded on 2026-09-16 **had never actually run**.
  `phi-purge-expired` reported `schedules_healed: 3, charges_healed: 1, ok: true` at 08:00, and
  `phi-drift-check` at 08:30 still counted the same 3/3/1/1/1 inline columns, with the rows'
  `updated_at` unmoved since July. Root cause: **`letter_schedules.patient_email` and
  `letter_charges.patient_email` were NOT NULL**, so every heal, close and release was rejected
  23502 the moment it tried to empty one. `assessments.patient_name` is nullable, which is why
  the 09-09 assessment migration worked and this one silently could not.
  - It was invisible because `healRow` awaited the PATCH and ignored the result, returning the
    S3 key regardless — so a rejected write was counted as a heal. Both that and
    `phi-purge-expired`'s `sbPatch` now throw on a non-ok response; each row is attempted
    independently, failures are counted into `result.failures`, and a run with any failure is
    recorded **not ok**. A job that cannot fail visibly is worse than no job.
  - **Two paid paths were broken for a day by the same constraint:** `letter-schedule.js`
    create and `create-letter-charge.js` correctly omit `patient_email` from their INSERTs,
    against a NOT NULL column with no default, so creating a recurring letter schedule or a
    letter pay-link returned 500. Constraint dropped on both tables; verified by inserting a
    row without `patient_email` and nulling it afterwards.
  - **Still outstanding:** the 3 schedules and 1 charge are unmigrated (counts above stand).
    They heal on the next 08:00 run now that the write can succeed, or sooner when the
    provider opens the Letter Generator (the list path self-heals). All four rows belong to
    `michael@thinkbeyondpsych.com`.
  - `putJson` runs before the PATCH, so each failed heal DID write the PHI to S3 and then fail
    to record the key. Orphaned objects exist under the schedule/charge prefixes; they are
    inside the AWS BAA and covered by the bucket lifecycle, but they are unreferenced and
    should be reconciled.

- **2026-09-18:** the letters migration **finally ran**, two days after it was recorded as done.
  All three `letter_schedules` rows now hold a `patient_s3_key` under
  `letters/schedule/2026-09-18/` with every inline column null — **migrated, not deleted**, which
  was the failure mode worth fearing (a cleared column with no key would have meant the PHI was
  dropped on the floor). The drift check's rules, run by hand, went from 5 failing to 1.
  - It was triggered by a human opening the **schedule modal**, not by the purge. Worth recording
    because the read-path self-heal is narrower than it looks: `loadSchedules()` is the only
    caller of `healSchedule` on that path, and it runs solely from `openScheduleModal()` — behind
    a button that is `display:none` unless the generated letter is `medicaid_private_pay`.
    `letter-autosend-cron` also heals, but only schedules it is DUE to process (the active one is
    not due until 2026-10-11). Opening the Letter Generator does nothing. If a row ever needs
    healing again, the purge is the only path that does not depend on someone clicking the right
    thing.
  - **Remaining:** the one `letter_charges` row. It is `paid`, so the next 08:00 purge heals it
    to S3 and then immediately releases it (deletes the object, nulls both columns) — the correct
    end state is empty, since the pay link was emailed on 2026-09-09. Minor inefficiency worth
    tidying eventually: healing a paid charge writes to S3 only to delete it moments later.
  - **Still outstanding:** the orphaned S3 objects from the 09-17 failed heals. Those were written
    under the `2026-09-17` date prefix and are unreferenced; today's good objects are under
    `2026-09-18`, so the two are cleanly separable by prefix when reconciling.

- **2026-09-18, 08:00 purge — inline PHI closed, orphan sweep refused.** The scheduled run
  healed the last `letter_charges` row to S3 and immediately released it: `charges_healed: 1`,
  `charges_released: 1`, and the row now reads `patient_email` null AND `patient_s3_key` null,
  which is the correct end state for a charge whose pay link was sent on 09-09. It also closed
  one schedule (`schedules_closed: 1`). **Every inline PHI column across letters, assessments and
  the certified-mail stub now counts zero**, confirmed by the 08:30 drift check: all 20 PHI
  counts are 0, `failing_ids` holds no PHI check. The letters migration is closed end to end.

  The **orphan sweep's first live run did not run**: `orphan_sweep: "error"`, `orphans_deleted: 0`,
  `orphans_skipped_recent: 0`, `failures: 1`. That is the designed refusal — the sweep deletes on
  a negative ("no row mentions this key"), so any incomplete picture aborts it and deletes
  nothing. Confirmed nothing was lost: 2 of 3 `letter_schedules` still hold their key (the third
  was the one closed on purpose), and no referenced object was touched.

  **The cause was not recoverable from here**, and the reason is worth keeping: the message went
  only to `console.error`, i.e. the Netlify function log, which a repo session cannot read (no
  log tool in the Netlify MCP surface, no CLI, no token). That is now fixed — the run record
  carries `orphan_sweep_error` and up to five `failure_details`, so a future run names its own
  cause instead of pointing at a log nobody in this loop can open.

  **ROOT CAUSE CONFIRMED (18 Sept, from the IAM console).** The `ses-send-pm` inline policy
  `tbp-letters-rw` read, in full:

  ```json
  { "Sid": "TbpLettersRW", "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": "arn:aws:s3:::tbp-letters/*" }
  ```

  Three object-level actions on an object-level resource, and no `s3:ListBucket`. `ListObjectsV2`
  is authorized against the **bucket** ARN (`arn:aws:s3:::tbp-letters`, no `/*`), which appears
  nowhere in that policy, so `listKeys()` is denied. It is the only call in the entire purge job
  that is not object-level, which is exactly why every heal, read and delete has always worked and
  this surfaced only on the sweep's first live run.

  **Fix APPLIED 18 Sept 2026** — a SECOND statement (it cannot be merged, the resources
  genuinely differ), scoped by prefix so the key can list under `letters/` and nowhere else,
  i.e. not the `assessments/` prefix in the same bucket. IAM takes effect immediately, so
  nothing was deployed and no key was rotated; the next 08:00 run picks it up:

  ```json
  { "Sid": "TbpLettersListForOrphanSweep", "Effect": "Allow",
    "Action": "s3:ListBucket",
    "Resource": "arn:aws:s3:::tbp-letters",
    "Condition": { "StringLike": { "s3:prefix": "letters/*" } } }
  ```

  The `*` in `letters/*` is load-bearing: `StringLike` on `"letters/"` alone would not match the
  request prefix `letters/schedule/`, and the sweep would be denied again for a subtler reason.

  **The policy is recorded here because it was not recorded anywhere.** When the sweep failed,
  neither the log nor the policy was reachable from a repo session, so a one-line permission bug
  could not be confirmed without Michael opening two consoles. An IAM policy that the code depends
  on belongs in the docs next to the code. If the `letters/` prefix condition ever needs widening,
  or a new prefix is swept, that is the line to change.

  So the 09-17 orphans are still there, still unreferenced, still inside the AWS BAA and still
  covered by the bucket lifecycle. Nothing is leaking; the cleanup is deferred one more day.

## Also holds member/business data (PII, not PHI — no BAA needed)

`accounts`, `contacts`, `subscriptions`, `baa_signatures`, consent records — clinician/customer
info, not patient PHI. Correctly in Supabase.

Not PHI does not mean not confidential. The **`baa-documents` Storage bucket** holding 49 executed
agreements was PUBLIC until 2026-09-16, at paths derived from the signer's email address, so any
one of them could be fetched by anyone who could guess a path. Bucket is private as of 2026-09-16;
`baa-document.js` is the only route in, and new objects store at a random path. Apply the same
question to any bucket added later: `avatars`, `post-files` and `post-images` remain public by
design — nothing confidential should be written to them.

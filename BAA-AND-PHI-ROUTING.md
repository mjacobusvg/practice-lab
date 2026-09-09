# BAAs held & PHI routing — the compliance map

**Purpose:** the single source of truth for *which Business Associate Agreements Think Beyond
Practice holds, with whom, and exactly how every kind of protected health information (PHI)
flows and under which agreement it is covered.* Read this before answering a compliance
question, changing any clinical data path, or updating the subprocessor page / privacy policy /
BAA. Keep it in sync with `subprocessors.html`, `privacy-policy.html`, `baa.html`, and
`COMPLIANCE-INTEGRATION.md`.

Last updated: 2026-09-09.

Legend: **[CONFIRMED]** = verified this session (console/email/live test). **[PER MICHAEL]** =
stated by the owner, document not re-verified here — confirm the signed document exists.

---

## 1. The one-line summary

Every PHI-bearing model call runs through **Amazon Bedrock under the AWS BAA** (not a direct
Anthropic account). Transcription runs through **Azure AI Speech under the Microsoft BAA**.
Application email that may carry PHI runs through **Amazon SES under the AWS BAA**. Nothing
clinical runs through Netlify or Supabase, and PHI is processed transiently and not retained on
TBP servers.

---

## 2. BAAs we HOLD (TBP as the covered entity's business associate / customer)

| Counterparty | Covers | Signed via / when | Status |
|---|---|---|---|
| **Amazon Web Services** | Amazon Bedrock (Claude inference), AWS Lambda (compute), Amazon S3 (transient storage), Amazon SES (email) — all AWS HIPAA-eligible services | AWS Artifact, ~Apr 28 2026 | **[CONFIRMED]** this is the primary PHI coverage; Bedrock live + tested 2026-08-31 |
| **Microsoft (Azure)** | Azure AI Speech (transcription) + Azure Blob Storage (transient audio) | — | **[PER MICHAEL]** signed; confirm the executed doc + that `AZURE_SPEECH_REGION` is a US region (`eastus`) |
| **Google (Workspace)** | Human-composed email through member-facing inboxes (support/legal/privacy) | — | **[PER MICHAEL]** signed; confirm executed doc |
| **OpenAI** | OpenAI API | Ironclad "HIPAA Amendment (Think Beyond Practice LLC and OpenAI)", 2026-05-06, fully executed | **[CONFIRMED]** held — but OpenAI is used ONLY for forum-search embeddings ("Ask the Archive"), **never for patient PHI**. This BAA is not on the PHI path. |
| **Notifyre** | SMS/fax vendor | AdobeSign "Notifyre Business Associate Agreement", 2026-05-19, completed | **[CONFIRMED]** held; not currently on a live PHI path |

### NOT held (and why that's OK)
- **Anthropic (direct API BAA)** — **not held.** The individual/pay-as-you-go Anthropic org was
  not eligible for a direct BAA, and the personal "Default" org (API key `sk-ant-…BwAA`) has
  30-day retention / ZDR off / no HIPAA. **We do not use it for PHI.** Claude is reached through
  AWS Bedrock instead, so the AWS BAA is the coverage. Do not point clinical traffic at
  `api.anthropic.com`.
- **Netlify, Supabase** — no BAA; deliberately kept off the PHI path (hosting / non-PHI data only).

---

## 3. BAA we ISSUE (TBP as business associate → clinician members as covered entities)

- **TBP member-facing BAA, current version 3.1** — the agreement each clinician signs before
  using the clinical tools. Drafted by counsel (Joel Schwarz, "Ver 6 FINAL"); members sign via
  DocuSign. Enforced at the tool gate (`auth-gate.js` → `check-baa-status`, exact-version match
  on 3.1, fails closed). Signing also records AI-processing authorization. Version chain that
  must move together: `auth-gate.js` `baaVersion`, `baa-sign.html` `BAA_VERSION`,
  `process-baa-signature.js`, `check-baa-status`, `baa.html`, and the signed `baa-template.pdf`.
- This is the *opposite direction* from Section 2 — it does not cover TBP's own use of
  subprocessors. Don't confuse "I have a BAA" (this one, or OpenAI/Notifyre) with "the model
  provider is covered" (that's AWS Bedrock).

---

## 4. How each kind of PHI is routed

### 4a. Clinical text — notes, letters, assessments, documentation audit, coding
Browser → **AWS Lambda Function URL** → **Amazon Bedrock** (Anthropic Claude models) → response
streamed/returned to browser. Under the **AWS BAA**. Content is processed transiently; the proxy
logs token-count metadata only (never message content), to Supabase `tool_usage`.

- Streaming tools (Scribe draft/review/preflight, Chart Coder, note builders, HPI generator,
  de-identifier): **`tbp-clinical-proxy-stream`** (Function URL Invoke mode = RESPONSE_STREAM).
  URL: `https://6jzvscd4oakgtlfjgsq5enbph40czool.lambda-url.us-east-1.on.aws/`
- Non-stream tools (Letter Generator, Monitoring Protocol, Termination Workflow, note-builder
  trial): **`tbp-clinical-proxy`** (BUFFERED). URL:
  `https://fskbd3q2z7vupixrevzpik7hsq0xchpj.lambda-url.us-east-1.on.aws/`
- Models (Bedrock **US** inference profiles — never the `global.` profile, to keep PHI in the US):
  - Sonnet: `us.anthropic.claude-sonnet-4-6` (env `BEDROCK_MODEL_SONNET`)
  - Haiku: `us.anthropic.claude-haiku-4-5-20251001-v1:0` (env `BEDROCK_MODEL_HAIKU`)
- Anthropic (the model developer) does **not** receive inputs/outputs and does not train on them
  — Bedrock runs the models inside AWS and does not share data with the provider.

### 4a-ii. Scanned records — page images → text (OCR)

A faxed or scanned record has no text layer, so there is nothing for the browser to extract and
the Scribe cannot read it at all without looking at the pages. The Scribe renders each page to a
JPEG **locally**, then posts it one page at a time to **`tbp-clinical-proxy`** (the same BUFFERED
Function URL, `action:'ocr'`), which runs **Amazon Textract** `DetectDocumentText` and returns the
text. Under the **AWS BAA** — Textract is HIPAA-eligible, same account and same agreement as
Bedrock, so this adds **no new subprocessor and no new BAA**. Synchronous only: no S3 bucket, no
async job, no retention. The extracted text then follows the normal 4a path.

- One-time IAM: `textract:DetectDocumentText` on the `tbp-clinical-proxy` execution role.
- Capped at 40 pages per document (cost/latency stop, not a technical limit).
- **Textract, deliberately not a vision model.** OCR must fail loudly rather than infer a
  plausible dose from an unreadable one. Textract returns garbage or nothing when it cannot read
  a page; it does not fabricate. Text obtained this way is labelled "read by OCR" on the source
  card so the clinician knows to check anything that matters against the page.
- Note that this changes what leaves the machine for scanned documents: **page images**, not
  extracted text. Same destination, same agreement. The gather-screen copy was corrected at the
  same time — it previously said "the file stays on your computer", which was true but was being
  read as "the record's content stays local", which was never true for any document.

### 4b. Ambient transcription — audio → transcript
Browser records → uploads audio **directly to Azure Blob Storage** (short-lived write SAS, container
`ambient-audio`, region `eastus` = US) → **AWS Lambda `tbp-azure-transcribe`** submits an **Azure AI
Speech** batch transcription over a read SAS → transcript returned to browser → **audio blob + job
deleted**. Audio and transcript live only in Azure (Microsoft BAA). Orchestration/keys run in the
Lambda (AWS BAA). Azure keys never reach the browser. (A "fast" transcription spike exists behind a
localStorage flag `tbp_fast_tx`, off by default, and its background writer still lives on Netlify —
port or delete before enabling.)

### 4c. Email that may carry PHI
- **Amazon SES** (AWS BAA): application-driven email — patient-facing assessment delivery links,
  letter-generator outputs, clinical workflow notifications.
- **Google Workspace** (Google BAA): human-composed email through support/legal/privacy inboxes.

### 4d. Non-PHI (no BAA needed, deliberately kept off the PHI path)
- **Netlify** — static hosting + non-clinical functions (auth, billing, forum, broadcasts, consent
  records). No patient PHI.
- **Supabase** — member/account/subscription/community/consent data, usage metadata (`tool_usage`,
  token counts only). **Not patient PHI** in the ordinary course. (See §6 open item on assessments.)
- **Stripe** — payments/billing.
- **OpenAI** — forum-search embeddings only ("Ask the Archive"). Never patient PHI.

---

## 5. AWS specifics (for future changes)

- Account **266359797908**, region **us-east-1**.
- Lambda functions: `tbp-clinical-proxy-stream` (RESPONSE_STREAM), `tbp-clinical-proxy` (BUFFERED),
  `tbp-azure-transcribe` (BUFFERED). Function URLs: Auth = NONE (auth enforced in-code via the
  signed session token), CORS on the Function URL (origin `https://thinkbeyondpractice.com`, methods
  POST, headers content-type + authorization).
- Each clinical function's execution role has an inline policy **`bedrock-invoke`** allowing
  `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `aws-marketplace:ViewSubscriptions`,
  `aws-marketplace:Subscribe`. (Marketplace actions were needed because Anthropic Bedrock models are
  subscribed through AWS Marketplace on first invoke.)
- Both Claude models are subscribed account-wide (Sonnet + Haiku).
- Bedrock model IDs are set as env vars (`BEDROCK_MODEL_SONNET`, `BEDROCK_MODEL_HAIKU`); region from
  `AWS_REGION`. Other env vars on the clinical functions: `SESSION_SIGNING_SECRET`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_KEY`; transcribe also has `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`,
  `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`. (Values live only in Lambda config — not in this repo.)
- Repo copies of the deployed handlers: `aws-lambda/clinical-proxy-stream-bedrock.mjs`,
  `aws-lambda/clinical-proxy-bedrock.mjs`, `aws-lambda/azure-transcribe.mjs`. The older Anthropic
  versions (`clinical-proxy-stream.mjs`, `clinical-proxy.mjs`) are kept for rollback reference only —
  do not deploy them (they hit `api.anthropic.com`, which is off-BAA).

### Maintenance switch
`auth-gate.js` has `TBP_MAINTENANCE` (currently `false`). Setting it `true` and pushing takes every
PHI/clinical tool offline behind a "Scheduled maintenance" screen (non-PHI pages unaffected). Owner
login and `tbp_maint_bypass='1'` (or `?maintbypass=1` once) bypass it for testing.

---

## 6. Open items (compliance follow-through)

- **Decommission the Netlify clinical functions.** `clinical-proxy-stream.mjs`, `clinical-proxy.js`,
  `azure-transcribe*.mjs`, and the unused `chart-coder-background/trigger/poll` are still deployed on
  Netlify but no longer called by the front end. Leave dormant briefly for rollback, then remove so
  PHI cannot route through Netlify at all. (`tbp_force_netlify` in `pm-ai-scribe.html` still points the
  Scribe back to them as a rollback — retire that flag when the Netlify functions are deleted.)
- **PHI at rest in Supabase — see `PHI-STORAGE-STATE.md` (verified 2026-09-09).** That file is the
  ground-truth inventory; keep it current. Summary:
  - **Letters (LIVE divergence).** `letter_send_log` (+ `create-letter-charge` for paid letters)
    stores the full letter **PDF** when the clinician opts into retention (default 14d / max 90d,
    then `pdf_purged_at`). This is NOT dead data — `letter-view.js` serves the stored PDF back as a
    "view the sent letter" link. So letter content (PHI) rests in Supabase (no BAA). As of 2026-09-09
    there is 1 stored PDF live. Fix options: move PDFs to **AWS S3** under the AWS BAA (correct
    long-term fix; touches `letter-log.js` / `create-letter-charge.js` / `letter-view.js` + a bucket
    on acct 266359797908), OR disable PDF retention (letters become metadata-only), OR disclose the
    retention accurately. Decision pending.
  - **Assessments (transient, currently clean).** `assessments.patient_name` +
    `assessment_results.responses` transit Supabase between patient-submit and provider-retrieve,
    then purge (`purged_at`); de-id metadata retained. Verified 2026-09-09: 0 live patient names,
    0 result rows. Storage is Supabase, not AWS — the AI SCORING moved to Bedrock, the raw-response
    STORAGE did not. A full move to AWS is a larger project, only needed if recurring/longitudinal
    assessments become a core feature.
- **Confirm Azure BAA document + US region**, and the **Google Workspace BAA document**.
- **Certified mail** (`send-certified-mail.js`) is a stub; before enabling, execute a mail-vendor BAA
  and store letter text on AWS, not Supabase.

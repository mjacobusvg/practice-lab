# HIPAA Infrastructure Remediation — move PHI processing under a BAA

**Goal:** close the one real gap from the compliance review — PHI currently flows through
Netlify functions (no BAA) and can rest in Supabase (no BAA). Fix = process and store PHI
only under a BAA. You already hold an **AWS BAA** (free, via AWS Artifact), so AWS is the
destination. Netlify keeps serving the static site; Supabase keeps non-PHI data.

Status legend: [DONE] / [DO TONIGHT] / [DECISION NEEDED]

---

## 0. What PHI touches what (the map)

| Where | PHI? | Fix |
|---|---|---|
| `tool_jobs` (chart-audit result cache, Supabase) | transient | **[DONE]** `chart-coder-poll.js` already deletes the row on fetch |
| `certified_mail_jobs.letter_text` (Supabase) | at rest | Feature is a **stub** (PostGrid adapter throws; won't transmit). Low real exposure. When you build the live vendor, store letter text on AWS, not Supabase. Purge any existing rows. |
| `assessments.patient_name` + `assessment_results.responses` (Supabase) | **at rest, LIVE** | **[DECISION NEEDED]** — see §3 |
| `assessment_score_series` (Supabase) | pseudonymized | Acceptable (one-way key, no name/responses); keep or move with §3 |
| Clinical proxies (`clinical-proxy-stream.mjs`, `clinical-proxy.js`) on Netlify | in transit | **[DO TONIGHT]** move to AWS Lambda — §2 |
| `azure-transcribe.mjs`, `azure-transcribe-fast-background.mjs` on Netlify | in transit | **[DO TONIGHT]** move to AWS Lambda — §2 |
| `chart-coder-background.js` on Netlify | in transit | **[DO TONIGHT]** move to AWS Lambda — §2 |

Everything else in Netlify functions (auth, billing, forum, broadcasts, consent records)
touches **member/business data, not patient PHI**, and can stay on Netlify.

---

## 1. Prereqs (confirm first)

- [ ] **AWS BAA is executed** (AWS Artifact → Agreements → AWS BAA). You said it is; confirm it covers the account you'll deploy to.
- [ ] **Azure Speech region is a US region** (`AZURE_SPEECH_REGION`; default `eastus` = US). Confirm the deployed value is US.
- [ ] Region for AWS: pick one US region (e.g. `us-east-1`) and deploy everything there.

---

## 2. Move the PHI-processing functions to AWS Lambda [DO TONIGHT]

These four handlers process PHI and must run under the AWS BAA instead of Netlify.

### 2a. The streaming one is the tricky one
`clinical-proxy-stream.mjs` returns Server-Sent Events (token streaming). On AWS this needs
a **Lambda Function URL with response streaming** (`awslambda.streamifyResponse(handler)`),
not plain API Gateway (which buffers). Deploy it as a Function URL with
`InvokeMode: RESPONSE_STREAM`. The other three can be plain Function URLs or API Gateway.

### 2b. Deploy steps (per function)
1. Create the Lambda (Node 20 runtime), paste the handler, adapt the export:
   - Netlify handler signature `exports.handler = async (event) => {...}` → Lambda works
     with the same shape via a Function URL; adjust how you read the body/headers
     (`event.body`, `event.requestContext.http.method`) and how you return
     (`{ statusCode, headers, body }`). For the streaming function use the
     `streamifyResponse` wrapper and write chunks to `responseStream`.
2. Set env vars on each Lambda: `ANTHROPIC_API_KEY`, `AZURE_SPEECH_KEY`,
   `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_KEY`, `AZURE_SPEECH_REGION`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (for usage logging only — no PHI content),
   `SESSION_SIGNING_SECRET` (to verify the signed session token, same as today).
3. Enable a **Function URL** for each; set **CORS** to allow your site origin
   (`https://thinkbeyondpractice.com`) and the headers/methods each uses.
4. Keep the **same auth check**: these functions verify the signed `tbp_auth_token`
   today — port `_lib/session.js` verification so Lambda rejects unauthenticated calls
   exactly as now. Fail closed.

### 2c. Cutover (safe, reversible)
1. Deploy all four to Lambda **in parallel** — Netlify versions stay live.
2. Add a single front-end config constant for the clinical endpoint base, e.g.
   `TBP_CLINICAL_API` (Lambda Function URL base) with a fallback to the current
   `/.netlify/functions/` path. Point the PHI tools (pm-ai-scribe / note-engine.js,
   pm-chart-coder, hpi-generator, letter/monitoring/termination) at it.
3. **Test on the demo patient** end to end: draft (streaming), transcribe, chart audit,
   letter. Confirm streaming still streams (the #1 thing that breaks).
4. Flip the constant to Lambda. Watch one real session.
5. Once stable, **remove/disable** the Netlify clinical functions so PHI can't route
   through them anymore. (Leaving them live but unused still means Netlify *could*
   process PHI — decommission them to actually close the gap.)

---

## 3. Assessments — DECISION NEEDED

The assessments feature stores a **patient name + screener answers** in Supabase. Two ways
to make it compliant; pick based on the product you want:

- **Option A — De-identify (keep in Supabase, free):** collect a clinician-chosen **label
  or initials** instead of the patient's name; the answers tied to a label are pseudonymized
  (same posture as the score-series). Cheapest. **Cost:** you lose the ability to auto-send
  recurring assessments to a known patient or tie a longitudinal record to a real identity.
- **Option B — Keep real patient identity, move to AWS (under BAA):** move the `assessments`
  / `assessment_results` tables to AWS (RDS or DynamoDB). Preserves auto-recurring sends and
  true longitudinal tracking. **Cost:** a small data migration + a second datastore.

Recommendation: if recurring/longitudinal patient assessment is on the near roadmap, do **B**
for this slice only. If not, do **A** now and revisit when you build that feature.

Also: purge existing rows that were written before the fix (old `assessments.patient_name`,
`assessment_results.responses`, `certified_mail_jobs.letter_text`).

---

## 4. Certified mail (stubbed) [when you build it]

`send-certified-mail.js` PostGrid adapter is a non-functional stub and refuses to transmit
unless `CERTIFIED_MAIL_BAA_CONFIRMED === 'true'`. Before enabling live certified mail:
store `letter_text` and addresses on AWS (not Supabase), execute a BAA with the mail vendor,
and set the flag. Until then, stop writing `letter_text` to Supabase in
`create-certified-checkout.js` and purge existing rows.

---

## 5. Verification checklist (before telling anyone "done")

- [ ] All four clinical functions serve from Lambda Function URLs (AWS BAA), streaming works.
- [ ] Netlify clinical functions decommissioned (return 410/removed).
- [ ] Assessments handled per §3 (A or B); old PHI rows purged.
- [ ] Azure Speech region confirmed US.
- [ ] Subprocessor page (already updated) matches reality: AWS = PHI compute/storage/email;
      Netlify = hosting; Supabase = non-PHI.
- [ ] Then the Stacie reply's answers #2/#4/#6/#7 are true and safe to send.

---

## Note

The AWS deploy itself requires access to the AWS account and cannot be done from a repo-only
session. This runbook is written so it can be executed by whoever holds AWS access. The
in-repo pieces (front-end endpoint constant, decommissioning Netlify functions, the
certified-mail and assessment code changes) can be done here once the Lambda URLs exist.

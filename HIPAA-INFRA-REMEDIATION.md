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

## 6. AWS account security (added Sept 2026, after a Trusted Advisor review)

Surfaced while investigating a Bedrock billing question. None of this touches the clinical
path: no Lambda, Bedrock or front-end changes, and the Scribe keeps serving throughout. It is
console work for whoever holds AWS access.

**Do these in order.** Step 6a.3 is the one that makes people think their new IAM user is
broken, and 6a.1 is the only step with real lockout risk.

### 6a. Stop operating as root

Day-to-day work was being done as the account root user. On an account under a BAA, root
should carry MFA and sit unused, with an ordinary IAM user for daily work.

- [x] **1. Root MFA.** DONE — virtual device registered 23 April 2026.
- [ ] **1b. Register a SECOND root MFA device.** STILL OPEN. AWS issues no recovery codes for root (an
      earlier version of this runbook wrongly said it did); the supported backup is up to 8
      registered devices. Add a second authenticator or a hardware key. Then confirm the root
      email and account phone number are current — that pair is the actual recovery path if
      every device is lost.
- [x] **2. Root access keys.** DONE — none exist. IAM dashboard shows 0 security
      recommendations. Nothing to revoke.
- [x] **3. Activate IAM billing access.** DONE 13 Sept. Root-only setting; without it the new
      IAM user signs in and Billing is simply absent.
- [x] **4. Create an IAM user.** DONE 13 Sept — `Michael`,
      `arn:aws:iam::266359797908:user/Michael`, `AdministratorAccess` attached directly, no
      access keys. **Username is `Michael`, capital M, and is NOT the root email address** —
      signing in with the email is what fails.
- [x] **5. MFA that user.** DONE 13 Sept — **passkey**, not TOTP. Worth noting for next
      time: the AWS virtual-MFA enrolment is fiddly (each page load mints a NEW secret, so a
      stale entry from a cancelled attempt never validates), and a passkey sidesteps the whole
      code-entry problem. Check whether the passkey is synced (iCloud Keychain / 1Password /
      Google) or bound to one device; if device-bound, losing that machine loses the factor.
- [x] **6. Tested and in use.** DONE 13 Sept. Sign-in URL:
      `https://266359797908.signin.aws.amazon.com/console`

Root is never deleted, only quiet. It stays needed for account settings, the billing toggle,
and closing the account.

### 6b. CloudTrail management events (was a RED Trusted Advisor check, 17/17 resources)

No record of who created, modified or deleted infrastructure. On a BAA footprint that is the
audit trail for the environment itself, and it cannot be reconstructed after the fact.

- [x] **DONE 13 Sept.** Trail `tbp-management-events`, multi-region, status Logging.
      Management events API activity = All. Data events OFF, Insights OFF, CloudWatch Logs
      OFF. Bucket `aws-cloudtrail-logs-266359797908-664276ba`.
- [x] **SSE-KMS deliberately NOT enabled.** A new KMS key is ~$1/month plus per-request
      charges, and CloudTrail logs are API metadata rather than PHI, so the free SSE-S3
      default is the right call here.
- [ ] **Log file validation — VERIFY.** It defaults to Disabled and is the setting that makes
      the trail defensible as an audit record rather than merely informative. Trail ->
      General details -> Edit -> tick Log file validation.
- [ ] Lifecycle rule on the log bucket. **Record the chosen retention period as a policy
      decision** rather than leaving it to a default.

The trail starts from creation and does not backfill: **13 Sept 2026 is day one of
infrastructure audit history for this account.**

First trail's management events are free; S3 storage is pennies at this volume. CloudTrail
logs are API metadata, not PHI, so this adds no BAA complication.

### 6c. IAM Access Analyzer (was a RED Trusted Advisor check, 17/17 resources)

No automated detection of resources shared outside the account — the check that would catch
an S3 bucket holding chart-audit payloads becoming externally reachable.

- [x] **DONE 13 Sept.** Resource analysis - External access, zone of trust current account,
      us-east-1. Free. The other two finding types (Internal access, Unused access) both
      charge fees and were deliberately not selected. One analyzer covers the whole footprint
      because every resource is us-east-1.
- [ ] Review the findings once they populate, especially anything on an S3 bucket.

### 6d. Lower priority (Trusted Advisor yellows)

- [ ] S3 incomplete multipart upload abort — lifecycle rule, abort after 7 days. Saves money.
- [ ] S3 server access logs on the PHI-payload buckets, targeting a separate log bucket.
      Useful for audit; has storage cost.
- [ ] IAM SAML 2.0 identity provider — inspect what it flags before changing anything.
      Likely stale config rather than a real gap.

### 6f. Stale access keys (from the credential report, 13 Sept 2026)

The account has five IAM users. **All five are service accounts** — every one has
`password_enabled: false`, so none is a console login. Root was the only way in, which is
what 6a fixes.

Two are live and must not be touched:

| User | Purpose | Key last used |
|---|---|---|
| `ses-send-pm` | SES API sending | 13 Sept 2026 |
| `ses-smtp-user.20260826-184558` | SES SMTP | 13 Sept 2026 |

Three carry **active long-lived access keys that nothing uses**. On an account under a BAA,
idle credentials holding live permissions are the thing to clear; the Bedrock one can still
call Bedrock and has not been used since 1 May.

- [x] `BedrockAPIKey-2wn5` DEACTIVATED 13 Sept. — last used 1 May 2026. Leftover from the Bedrock cutover
      experiments; the Lambdas authenticate via execution roles.
- [x] `ses-smtp-user.20260529-170928` DEACTIVATED 13 Sept. — never used. Superseded by the August SMTP user.
- [x] `tbp-transcribe-medical` DEACTIVATED 13 Sept. — never used. Transcription went to Azure AI Speech instead.

**All three deactivated 13 Sept, not deleted.** Leave inactive a couple of weeks, then delete
if nothing breaks. Deactivating is instantly reversible.

The one to watch: if magic-link / confirmation email stops arriving, the May SMTP user was in
use after all — reactivate it. The evidence said otherwise (it had never authenticated once
since 30 May, while the August user shows `ses-smtp` traffic daily, and Supabase Auth mail
demonstrably works), but that is the symptom and the fix is one click.

Also worth noting: neither live key has been rotated since it was created (30 May and
27 Aug 2026). Not urgent, but long-lived static keys are what AWS guidance steers away from.

### 6e. Support console permissions (deadline: 16 November 2026)

AWS is requiring an explicit permission for support actions from that date. Root is
unaffected. Once 6a is done and daily work runs through an IAM user, that user needs
`AWSSupportAccess` (or `AdministratorAccess`, which covers it) or it loses the ability to
open cases.

---

## Note

The AWS deploy itself requires access to the AWS account and cannot be done from a repo-only
session. This runbook is written so it can be executed by whoever holds AWS access. The
in-repo pieces (front-end endpoint constant, decommissioning Netlify functions, the
certified-mail and assessment code changes) can be done here once the Lambda URLs exist.

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
- [x] **1b. Second root MFA device.** DONE 13 Sept — a second passkey. AWS issues no recovery codes for root (an
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
- [x] **Log file validation ENABLED 13 Sept.** It defaults to Disabled; this is the setting
      that makes the trail defensible as an audit record rather than merely informative.
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
- [x] **Findings reviewed 13 Sept. Four, all expected.** Every one is a Lambda Function URL
      with `Auth = NONE`, reported as `All Principals / Write`:
      `tbp-azure-transcribe`, `tbp-clinical-proxy`, `tbp-clinical-proxy-stream`,
      `tbp-assessments`.

      **These are by design, not misconfigurations.** A browser cannot sign a SigV4 request
      without AWS credentials, so IAM auth on the Function URL is not an option; auth is
      enforced in-code via the signed session token, exactly as §5 of
      `BAA-AND-PHI-ROUTING.md` describes. Nothing reaches a model without a valid token.
- [x] **Archived 14 Sept. No archive rule, deliberately.** Archiving is already durable — an
      archived finding stays archived unless the underlying resource policy changes, which is
      precisely when it should resurface. An archive rule matching `AWS::Lambda::Function`
      would also auto-suppress a genuinely NEW public Lambda, which is the opposite of what
      this tool is for. If a fifth intentionally-public function is ever added, archive that
      one finding too.

**The real gap these surface (NEW, open):** anyone on the internet can *invoke* these
functions. They get a 401/403 without a valid token, but **a rejected request still costs a
Lambda invocation.** With no ceiling, sustained hammering runs up spend and can exhaust
account-wide concurrency, which would take the Scribe down for paying members.

- [ ] Set **reserved concurrency** on each of the four functions (Lambda -> function ->
      Configuration -> Concurrency). Bounds both the bill and the blast radius. Pick ceilings
      from real peak usage — `tool_usage` has the traffic shape.

### 6d. Trusted Advisor yellows — CLOSED

- [x] **S3 incomplete multipart upload abort** — DONE 13 Sept. `abort-incomplete-mpu`, 7 days,
      on `tbp-letters` and `tbp-ses-inbound`. Added as a SEPARATE rule on `tbp-letters` rather
      than editing `expire-letters-90d`, so the working PHI retention rule was never touched.
- [x] **S3 server access logging** — DONE 14 Sept. New bucket `tbp-s3-access-logs` (us-east-1,
      ACLs disabled, public access blocked, SSE-S3). Enabled on `tbp-letters` and
      `tbp-ses-inbound`, each under its own prefix (`s3://tbp-s3-access-logs/<bucket>/` — the
      trailing slash is required or the prefix is glued onto the filenames instead of making a
      folder) so the two sets do not interleave. Log bucket carries `access-logs-retention-7y`
      (2557 days) plus MPU abort. This is the object-level audit trail — who read which
      object — that CloudTrail data events would otherwise provide at per-event cost.
- [x] **IAM SAML 2.0 identity provider** — CLOSED as not applicable. The check advises
      federating instead of using IAM users, which is guidance for organisations with a staff
      directory. One person, one IAM user. Deliberately left yellow.

### 6g. Lambda concurrency — alarm, NOT a cap (decided 14 Sept)

The four Function URLs are invokable by anyone and a rejected request still costs an
invocation, so uncapped concurrency is in principle a cost-and-availability exposure.

**Reserved concurrency was proposed and rejected.** Michael's objection overrides the earlier
recommendation and was correct: reserved concurrency is a ceiling as well as a floor. The risk
it mitigates is hypothetical (a deliberate attacker); the risk it creates is near-certain (a
silent cap on the growth path that has to be remembered, failing by throttling paying members
unnoticed). Measured peak is 21 calls/min on the Scribe against an account limit of 1000
concurrent — nowhere near anything.

- [x] **CloudWatch alarm instead.** `lambda-concurrency-abnormal` on `AWS/Lambda`
      `ConcurrentExecutions` across all functions, Maximum, 5-minute period, `> 200` for 2 of
      2 datapoints, notifying SNS topic `tbp-alerts`. Roughly 10x the busiest observed moment
      and a fifth of the account ceiling: normal growth never touches it, an attack or runaway
      loop trips it inside ten minutes. Constrains no request.
      **The SNS email subscription must be confirmed or the alarm cannot notify.**
- [ ] Optional: AWS Budgets monthly cost alert (~$150, alerting at 80% and 100%) for the cost
      side of the same scenario. Current AWS spend is ~$50/month.

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

## 7. Supabase views were readable by `anon` (found 18 Sept 2026, fixed same day)

A third security pass enumerated `public` **views** for the first time. The two prior passes
(16 and 17 Sept) enumerated tables and their RLS policies and never looked at views. That gap
is why this survived them.

**Why a view bypasses RLS:** a Postgres view runs as its OWNER unless `security_invoker` is
set (PG15+; this project is PG17). So a view over an RLS-protected table returns the owner's
rows to whoever can `SELECT` the view. RLS on the base table is not consulted. Three views in
`public` carried a `SELECT` grant to `anon`, i.e. to anyone holding the publishable key that
`platform.html` ships to the browser. Verified live with that key before the fix:

| View | Status then | What it returned |
|---|---|---|
| `baa_signatures_summary` | **206, 45 rows** | `member_name`, `member_email`, `entity_name`, `signer_title`, **`ip_address`** |
| `member_ai_cost` | **206, 19 rows** | `account_email`, `name`, `tier`, `comped`, `comp_reason`, `calls_30d`, token counts |
| `member_directory` | 206, 418 rows | `id`, `name`, `avatar_url` only — intended, see below |

`baa_signatures_summary` is the one that matters: the BAA PDFs were locked at the S3 bucket in
the earlier H3 work, but the **signer registry** — who signed, for what entity, from what IP —
stayed world-readable through this view. Locking the documents did not lock the list of who
signed them. `member_ai_cost` exposed the member list with tier, comp status and comp reason.

Neither view is referenced anywhere in the codebase (checked), so revoking them broke nothing.
Applied:

```sql
revoke all on public.baa_signatures_summary from anon, authenticated;
revoke all on public.member_ai_cost        from anon, authenticated;
alter view public.baa_signatures_summary set (security_invoker = on);
alter view public.member_ai_cost        set (security_invoker = on);
```

The `revoke` is the fix; `security_invoker = on` is the belt-and-braces so a future re-grant
still can't read past the base tables' RLS. Verified after, by assuming the role in-database
(`set local role anon`), which is the same role PostgREST uses for an unauthenticated request:

```
baa_signatures_summary  DENIED: permission denied for view baa_signatures_summary
member_ai_cost          DENIED: permission denied for view member_ai_cost
member_directory        READABLE rows=418
```

`service_role` still reads all three, so the Netlify functions are unaffected.

**`member_directory` is deliberately left readable.** Mention search in `platform.html`
(:4754, :4854) queries it as `anon`, and it exposes only `id`/`name`/`avatar_url`. Do NOT set
`security_invoker = on` on it — the base table's RLS would then return zero rows to `anon` and
mention autocomplete would silently stop finding anyone.

`membership_truth` was already closed to `anon` and `authenticated`; no change.

**Standing rule this adds:** a new view in `public` is public unless you say otherwise. When
you create one, decide its grants in the same migration, and treat `security_invoker` as the
default rather than the exception. Re-run `get_advisors(security)` after any view change — it
flags these as `security_definer_view`.

---

## 8. pg_net — grants to PUBLIC that no role here can revoke (18 Sept 2026)

The `extension_in_public` advisor flags `pg_net`. The advisor's own remedy ("move it to
another schema") is impossible and would not help. What is actually wrong is the grants.

**What pg_net is here for.** Two `pg_cron` jobs use it to POST to Netlify on the hour:

| job | schedule | target |
|---|---|---|
| `assessment-autosend-hourly` | `0 * * * *` | `/.netlify/functions/assessment-autosend-run` |
| `letter-autosend-hourly` | `15 * * * *` | `/.netlify/functions/letter-autosend-cron` |

Both send `X-Autosend-Secret`, read from `vault.decrypted_secrets`. Both run as `postgres`.
Nothing else in the project touches `net.*`.

**The finding.** pg_net's install script grants to **PUBLIC**, not to `anon` and
`authenticated` individually:

```
schema net             =U/supabase_admin                 -- USAGE to PUBLIC
net.http_request_queue =arwdDxtm/supabase_admin          -- ALL to PUBLIC
net._http_response     =arwdDxtm/supabase_admin          -- ALL to PUBLIC
net.http_get/http_post/http_delete/worker_restart/...  =X/supabase_admin
```

So it is not just read. PUBLIC can INSERT, UPDATE, DELETE and TRUNCATE both tables, call
`net.http_post` (outbound HTTP issued by the database: SSRF and an exfil channel), and call
`net.worker_restart`. And `net.http_request_queue` stores the request **headers** in
cleartext, so a row sitting in that queue carries `X-Autosend-Secret` in the clear for as
long as it takes the worker to drain it.

**It cannot be revoked from here.** The grantor is `supabase_admin`; `current_user` is
`postgres`, and `pg_has_role('postgres','supabase_admin','MEMBER')` is **false**. A REVOKE
only removes grants made by the current role, so `revoke ... from public` (and from `anon`,
`authenticated`) runs without error and changes nothing — the ACL was re-read afterwards and
had not moved. `pg_net` is also `extrelocatable = false` and owned by `supabase_admin`, so
`ALTER EXTENSION pg_net SET SCHEMA` fails; it would also be the wrong move, because it would
drag `net.http_request_queue` out from under the background worker. `pg_net.ttl` (how long
response bodies are retained, default 6 hours) is a postmaster-level GUC: `ALTER DATABASE
... SET pg_net.ttl` is rejected with `55P02 parameter "pg_net.ttl" cannot be changed now`.

**What is actually holding the line.** PostgREST only serves schemas on its exposed list.
Probed live, as `anon`, against the deployed API:

```
GET /rest/v1/http_request_queue?select=id&limit=0   Accept-Profile: net
  -> 406  {"code":"PGRST106","message":"Invalid schema: net",
           "hint":"Only the following schemas are exposed: public, graphql_public"}
```

So `net` is unreachable over the API today. That is the whole control, and it is a dashboard
setting (Settings -> API -> Exposed schemas) recorded in no file in this repo. Adding `net`
to that list — for any reason, by anyone — turns the grants above into an unauthenticated
SSRF plus a read of the autosend secret. The SECURITY DEFINER functions cannot be used as a
side door: all nine have `search_path` pinned to `public` (or `public, pg_temp`), which does
not include `net`.

**What was done instead.** `phi-drift-check.js` now runs that exact probe daily and fails
the check `api.net_schema_exposed` if the API ever answers anything but 406. It is the only
enforcement available to us: we cannot remove the privilege, so we watch the one setting
that makes the privilege reachable.

**Standing rule:** never add `net` (or any schema other than `public` and `graphql_public`)
to the exposed-schema list. If a future need seems to require it, the fix is a SECURITY
DEFINER function in `public` with a pinned `search_path`, not an exposed schema.

Left alone deliberately: the `vector` extension is also in `public` and is benign (operator
and type support functions, no I/O). `vault.decrypted_secrets` was checked at the same time
and is correctly closed to `anon` — no schema USAGE, no table SELECT.

---

## 9. Password policy — weak, and enforced only in the browser (18 Sept 2026)

The `auth_leaked_password_protection` advisor is not a formality here. **122 of 128 auth
users have a password** (`auth.users.encrypted_password` not null, 18 Sept 2026), because
`platform.html` offers an opt-in password alongside the magic link. So GoTrue's password
rules are a live control on 122 accounts.

**What the server actually enforces.** Probed live against the deployed GoTrue, no account
created (see the safety note below):

| probe | result |
|---|---|
| password `abc` | 422 `weak_password`, `reasons: ["length"]`, *"Password should be at least 6 characters"* |
| password `aB3$xY9` (7 chars) | **accepted** — falls through to the email error |
| password `password123` | **accepted** — falls through to the email error |

So: minimum **6**, no character-class rule, and no breach check. `password123` — one of the
most-breached strings in existence — is a valid password on this project today.

**The browser is doing the work.** `platform.html` requires 8 characters in both places that
set one (`signUpFree()` at :2593, `saveNewPassword()` at :2472). That is a nudge, not
enforcement: it is client-side JavaScript in front of an API that accepts 6. Anyone posting
straight to `/auth/v1/signup` gets the server's rule, which is the only rule that counts.

**This cannot be changed from a repo session.** It is not SQL and not a file — the auth
config is a platform setting, and the Supabase MCP surface available here has no write for
it. Michael has to set it in the dashboard:

> **Authentication -> Sign In / Providers -> Email** (password settings)
> 1. **Minimum password length: 8** (matches what the UI already promises)
> 2. **Leaked password protection: ON** — checks new passwords against HaveIBeenPwned
> 3. Character requirements: optional. Length plus the HIBP check buys more than forcing a
>    symbol does, and symbol rules push people toward predictable substitutions.

**Residual after the toggle.** HIBP is checked at signup and at password change. It does
**not** re-check the 122 passwords already set, so a member who chose `password123` in July
keeps it. Nothing forces a reset without a flow that interrupts everyone at sign-in, which
is a product decision, not a security patch. Worth knowing; not worth ambushing 122 people
over on its own.

**Now monitored.** `phi-drift-check.js` runs both probes daily:

- `auth.password_min_too_low` — sends a password one character under 8 and fails if GoTrue
  takes it.
- `auth.leaked_password_protection_off` — sends `password123` and fails unless GoTrue
  rejects it with `reasons` containing `pwned`.

**Both will report as failing until the toggles are set**, which is correct: they are
reporting today's real state. The first scheduled run after this lands will therefore send
one alert.

**Why the probe is safe.** GoTrue validates the password BEFORE the email (proved: an
invalid email with a 3-character password came back `weak_password`, not an email error). So
the probe sends an email address with no `@` in it at all — `phi-drift-check-probe` — which
can never pass format validation. A rejected password answers 422 `weak_password`; an
accepted one falls through to 400 *"Unable to validate email address"*. No account is
created on either branch, and a 200 would be treated as an error rather than a pass.
Confirmed: zero rows in `auth.users` matching any probe address after all of them ran.

---

## Note

The AWS deploy itself requires access to the AWS account and cannot be done from a repo-only
session. This runbook is written so it can be executed by whoever holds AWS access. The
in-repo pieces (front-end endpoint constant, decommissioning Netlify functions, the
certified-mail and assessment code changes) can be done here once the Lambda URLs exist.

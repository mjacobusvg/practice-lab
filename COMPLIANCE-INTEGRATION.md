# COMPLIANCE-INTEGRATION.md

Single source of truth for building any Think Beyond Practice tool that touches
PHI, captures consent, sends communications, or persists user data. If you are an
AI assistant helping build a tool, read this file first and build to these
conventions. Do not re-derive them from screenshots or memory.

This file is authoritative. When the gate logic, the BAA or Terms version, a
consent table shape, the tool classification, or a send/job pattern changes,
update this file in the SAME commit. Same discipline as MODEL-REGISTRY.md.

Last verified against live code and Supabase schema: June 2026.
BAA version + AI Scribe classification re-verified against live code: July 2026
(BAA now 3.1; pm-ai-scribe added to the PHI-gated list).

---

## 0. New PHI tool checklist (read this, then read the relevant section)

When building a new tool, work through this:

1. Does the tool process clinical content that may contain PHI (notes,
   assessments, letters, patient summaries, safety plans, anything a clinician
   pastes about a patient)? If yes, it MUST be PHI-gated. Do nothing: the gate is
   on by default. See Section 1.
2. Is it a non-PHI reference or practice-data tool (interaction checker,
   monitoring reference, LAI guide, HIPAA hub, compliance tracker, the Vault,
   Ask the Archive, Practice Lab, Credentialing Hub, marketing pages)? Then and
   only then pass `skipPHIGate: true`, and record why in the call. See Section 1.
3. Does it capture a NEW kind of consent (beyond BAA and Terms)? Follow the
   consent-recording pattern in Section 2. Do not invent a new shape.
4. Does it send email or fax? Use the shared send modal. Do not write new SES
   logic. See Section 3.
5. Does it run a long AI job (more than a few seconds)? Use the
   background/trigger/poll job pattern. See Section 4.
6. Does it call an AI model? Add or update its row in MODEL-REGISTRY.md in the
   same commit (file, endpoint, model, purpose).
7. Does it persist per-user data? Use the generic `user-tool-data` function and
   the `user_tool_data` table. Do not create a new table per tool unless the
   data is genuinely structural. See Section 5.
8. Tier scope: which membership tier can use this? See Section 6.

---

## 1. The PHI gate (auth-gate.js)

Every protected page includes `/auth-gate.js` and calls `TBPAuth.protect({...})`.

The gate is OPT-OUT. The BAA + Terms PHI gate runs by DEFAULT for every tool.
A page only skips it by explicitly passing `skipPHIGate: true`. This means a NEW
tool is gated unless you deliberately exempt it. That is the safe failure mode.
The gate FAILS CLOSED: any error, ambiguity, or unidentifiable member sends the
user to the BAA path rather than letting them through.

### Standard call (PHI tool, default gated)

```html
<script src="/auth-gate.js"></script>
<script>
  TBPAuth.protect({
    toolName: 'Clinical Note Builder',
    spaceId: 2546298,            // full tier; omit for any-active-member
    onVerified: function () { /* load the tool here */ }
  });
</script>
```

### Exempt call (non-PHI tool only)

```js
TBPAuth.protect({
  toolName: 'Interaction Checker',
  skipPHIGate: true,            // exempt: no PHI processed. Document why.
  onVerified: function () { /* load the tool */ }
});
```

### What the gate does, in order

1. Member identity. Authentication is Supabase-only (Circle is retired). If a
   valid signed `tbp_auth_token` is already in localStorage, the gate proceeds.
   If not, it redirects to `/platform?returnTo=<this tool>`, where the member
   signs in via Supabase (magic link / Google); `platform-auth.js` mints the
   signed token from the verified Supabase session and returns them to the tool.
   The platform login sets, in localStorage:
   - `tbp_verified_email` (the canonical identity key every backend reads)
   - `tbp_auth_token` + `tbp_auth_expiry`
   - `tbp_tier`
   If a member holds a token but lacks the required tier (forum-only on a Full
   tool), the gate shows an upgrade screen rather than redirecting.
2. If not `skipPHIGate`, runs the PHI gate (`runPHIGate`):
   - BAA check via `check-baa-status`. Requires the CURRENT version by exact
     string match. A member who signed an older version (e.g. 1.0) does NOT
     satisfy the current version and is routed to `/baa-sign.html` to re-sign.
   - Terms check via `record-terms-acceptance` with `action:"check"`. If not
     accepted, shows the Terms overlay, which records acceptance with
     `action:"record"` before proceeding.
   - Only when BOTH pass does `onVerified` run.

### Current versions (authoritative)

- BAA version required by the gate: **3.1**
  (in `auth-gate.js`, `baaVersion = options.baaVersion || '3.1'`)
  Bumped 3.0 -> 3.1 (August 2026). 3.1 NARROWS Business Associate's rights over
  de-identified/aggregated data (§3.1.4, §3.3): such data may be used ONLY to
  monitor/measure/improve the quality, safety, and performance of the Services;
  it may NOT be used to train external/third-party AI models or be sold/licensed;
  any research use requires the Covered Entity's separate written opt-in. 3.1 also
  reflects the AI-processing authorization captured at signing (baa-sign.html
  `aiAuthCheckbox`, the §3.1.4 prior-written-permission). The whole chain is aligned
  at 3.1: `baa-sign.html` (`BAA_VERSION = '3.1'`) -> `process-baa-signature.js`
  writes `baa_version: '3.1'` -> `check-baa-status` returns the latest signature ->
  the gate exact-matches '3.1'. A member on an earlier version is routed to re-sign.
  NOTE: the signed PDF template (`baa-template.pdf`) is a binary and must be
  regenerated to v3.1 to match the web version and the signing flow.
- Terms version: **interim_v1**
  (in `auth-gate.js`, `termsVersion = options.termsVersion || 'interim_v1'`,
  and `record-terms-acceptance.js`, `CURRENT_TERMS_VERSION = 'interim_v1'`)

When the BAA or Terms version is bumped, change it in BOTH the gate defaults and
the recording function, force re-acceptance is automatic because the check is an
exact-version match, and update this section.

KNOWN INCONSISTENCY TO BE AWARE OF: the `baa_signatures` table column
`baa_version` still DEFAULTS to `'1.0'` at the database level. The signing flow
must write the current version (3.0) explicitly on insert; never rely on the
column default. If you build or touch the BAA-signing function, confirm it passes
`baa_version` explicitly. (process-baa-signature.js already does: it writes the
`baaVersion` the client submits, and baa-sign.html submits '3.0'.)

### Endpoints the gate calls (must exist)

- `/.netlify/functions/platform-auth` (Supabase session -> signed token, tier)
- `/.netlify/functions/check-baa-status` (returns `{ hasBaa, baaVersion }`)
- `/.netlify/functions/record-terms-acceptance` (check + record)

### Current tool classification

PHI-GATED (default, no skip flag):
pm-clinical-note-builder, note-builder-trial, chart-coder-trial, pm-chart-coder,
pm-letter-generator, pm-termination-workflow, pm-crisis-safety-plan,
pm-ai-scribe (the AI Scribe; runs the BAA + Terms gate via protect(), termsVersion
'interim_v1'). The Patient Desk shell (ai-scribe-workspace.html) loads pm-ai-scribe
in an iframe, so the gate fires inside the iframe at use time; the shell itself
processes no PHI. The demo (`?demo=1`) is exempt (canned content, no real PHI).
Any new clinical-content tool joins this list by default.

EXEMPT (`skipPHIGate: true`, non-PHI):
pm-interaction-checker, pm-monitoring-protocol, pm-lai, pm-hipaa-hub,
pm-compliance-tracker, vault, ask-archive, practice-manager hub,
practice-lab-hub and sub-pages, members, index.html (Credentialing Hub),
and the public marketing/demo pages (e.g. ai-scribe-demo.html).

When you add a tool, add it to the correct list here.

---

## 2. Consent recording pattern

All consent/acceptance events are recorded server-side via a Netlify function
using `SUPABASE_SERVICE_KEY` (never the anon key, never client-side), capturing
the real client IP and user-agent. The canonical example is
`record-terms-acceptance.js`. Mirror it for any new consent type.

### The pattern (from record-terms-acceptance.js)

- Two actions on one endpoint: `action:"check"` (has this member accepted version
  X?) and `action:"record"` (persist acceptance). The gate uses check on load and
  record on agreement.
- Idempotent: upsert with `onConflict` on the natural key and
  `ignoreDuplicates: true`, so one row per (identity, version). Re-accepting is a
  no-op success, not a duplicate.
- Captures `ip_address` from `x-nf-client-connection-ip` (fallback
  `x-forwarded-for` first hop) and `user_agent` from headers.
- Supabase client: `createClient(url, SERVICE_KEY, { auth: { persistSession:
  false, autoRefreshToken: false } })`.
- Version is a column, defaulted in code via a `CURRENT_*_VERSION` constant, and
  always written explicitly.

### Existing consent tables (live schema, RLS enabled on all three)

- `terms_acceptances`: id, member_email, member_name, terms_version
  (default `interim_v1`), accepted_at, ip_address, user_agent, created_at.
  Natural key for upsert: (member_email, terms_version).
- `baa_signatures`: id, member_name, member_email, entity_name, signer_title,
  signed_at, ip_address, baa_version (DB default `1.0`; write `3.0` explicitly),
  pdf_storage_path, circle_member_id, created_at.
- `loa_signatures` (credentialing letter-of-authorization): id, email,
  signed_name, signed_at, ip_address, user_agent.

### Building a new consent type (e.g. patient recording-consent)

Create `record-<thing>-consent.js` modeled exactly on
`record-terms-acceptance.js`. Reuse the check/record action split, the
service-key client, the IP/user-agent capture, and the idempotent upsert on the
natural key. If it needs a new table, give it: id (uuid pk), the identity column
(email or member id), a `*_version` text column with a code-side
`CURRENT_*_VERSION` constant, accepted_at/signed_at timestamptz default now(),
ip_address, user_agent, created_at. Enable RLS on the new table (service-key
writes bypass RLS; see Section 7). Then document the new table here.

---

## 3. Sending email / fax (send-util.js)

`send-util.js` is the SHARED client-side send modal. Include it and call
`openSendModal({...})`. Do not write new send UI or new SES logic per tool.

```js
openSendModal({
  content: "The text to send",
  subject: "Information from Your Prescriber",
  tool: "Clinical Note Builder",
  type: "patient_summary",   // patient_summary | letter | safety_plan | attestation | superbill
  replyTo: "provider@example.com"   // optional; falls back to vault email
});
```

The modal posts to two backend functions (the actual delivery/SES logic lives
server-side in these; do not reimplement it client-side):

- Email -> `/.netlify/functions/send-document`
  body: `{ to, subject, body, replyTo, tool }`, expects `{ success, error? }`.
- Fax -> `/.netlify/functions/send-fax`
  body: `{ to, content, toName, fromName, fromPractice, subject, tool,
  clinicianEmail }`, expects `{ success, message?, error? }`.

Notes:
- The modal auto-appends a PHI/confidentiality footer and shows a consent
  disclaimer ("by sending, you confirm the recipient has consented to receive
  this information via email"). Keep that posture in any new send surface.
- Provider reply-to / practice identity is read from the Vault localStorage key
  `credentialing-hub-profile`.
- SMS exists (`send-sms.js`) but is OFF by default. Do not add an SMS send branch
  to a new tool unless explicitly decided. The `providers.notify_sms` column and
  `notifications.channel = 'sms'` support it for later.

---

## 4. Long-running AI jobs (background / trigger / poll)

For any AI call that can exceed a few seconds, do NOT block the request. Use the
background/trigger/poll pattern (the permanent fix for Netlify 504 idle timeouts;
streaming proxies are the other accepted approach for token streaming).

Job tables (live schema):
- `tool_jobs`: job_id (text pk), tool, status (default `pending`), result (jsonb),
  created_at. Generic job table for Practice Manager tools.
- `archive_jobs`: job_id (text pk), status, result (jsonb), created_at. Used by
  Ask the Archive.

Pattern:
1. Client POSTs the request; the trigger function inserts a `tool_jobs` row with
   status `pending`, kicks off the background function, and returns the `job_id`
   immediately.
2. The background function does the AI work and updates the row to
   `complete` (with `result`) or `error`.
3. Client polls a status endpoint by `job_id` until status is terminal, then
   renders `result`.

Any tool function calling a model must also have its row in MODEL-REGISTRY.md.

---

## 5. Per-user persistence (user-tool-data.js + user_tool_data)

For saving per-user, per-tool state, use the generic `user-tool-data` function.
Do not create a new table per tool unless the data is genuinely relational.

- Function: `/.netlify/functions/user-tool-data`, actions `load` / `save` /
  `delete`, body `{ token, toolId, action, data }`.
- Identity comes from the SIGNED session token (verified server-side via
  `_lib/session.js`); the client no longer supplies its own email. The old
  email + Circle round-trip has been removed entirely.
- Table `user_tool_data`: id, email, tool_id, data (jsonb), created_at,
  updated_at. Upsert on conflict (email, tool_id). RLS enabled; the function uses
  the service key.
- The email stored on each row is derived from the verified token, not the client.

---

## 6. Identity, tiers, and env vars

Identity key everywhere: `tbp_verified_email` (localStorage, set by the gate).

Tiers (live `accounts.tier` enum; the authoritative source, driven by Stripe):
- `free` = open-registration teaser tier
- `forum` = $50 grandfathered forum + Ask the Archive only (NO Practice Manager)
- `full` = everything

Legacy full-tier marker: `2546298`. This was the Circle full-space id; it now
survives only as a client-side "require full tier" flag some tool pages still
pass (`spaceId:2546298`), treated as `requireFull:true`. Tier itself comes from
the signed token claim / `accounts.tier`, never a Circle lookup.

Environment variables (already set in Netlify; never hardcode secrets):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` (service role; server-side only; bypasses RLS)
- `SUPABASE_ANON_KEY` (routes the platform-auth session-verify call)
- `SESSION_SIGNING_SECRET` (HMAC key for signed tokens; server-side only)
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` for model calls
- `RESEND_API_KEY` / SES credentials for send functions
- `STRIPE_SECRET_KEY` for payments

Supabase REST/client conventions:
- Server functions use `createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth:
  { persistSession: false, autoRefreshToken: false } })`, or the REST endpoint
  with `apikey` + `Authorization: Bearer` headers and
  `Prefer: return=representation` (see user-tool-data.js for the REST style).
- The service key bypasses RLS, so server functions work regardless of RLS state.

---

## 7. OPEN ITEM: Row Level Security gaps (address deliberately, not blindly)

A live schema scan (June 2026) found RLS DISABLED on 18 tables. The consent and
PHI-bearing tables are already protected (baa_signatures, terms_acceptances,
providers, applications, user_tool_data, crisis_resources, note_builder_trials
all have RLS on). But several exposed tables hold sensitive data and should be
addressed:

- `loa_signatures` (signed authorizations with IP/user-agent)
- `certified_mail_jobs` (letter text, names, addresses)
- `referral_attributions` (member emails, payout status)
- `credentialing_access` (Stripe customer/session IDs)
- `evaluations` (learner names/emails)
- `subscriptions` (billing status)

Do NOT blanket-enable RLS: enabling it without policies blocks all access and can
take tools offline. Most of these are written/read ONLY by Netlify functions
using the service key (which bypasses RLS), so for those, enabling RLS with no
anon policy is safe and strictly better. Tables read client-side with the anon
key need an explicit policy first. This needs a deliberate per-table pass:
classify service-key-only vs anon-read, then enable RLS with the right policy per
table. Tracked here so it is not forgotten.

NOTE on the Assessment Suite trend store (`assessment_score_series`): this table
is PSEUDONYMIZED PHI, not de-identified. It holds scores + dates under a one-way
hash of name+DOB (no name, no item responses). Because the key is derived from
patient identifiers, it does not meet HIPAA Safe Harbor de-identification and
should be treated as PHI: access-controlled, RLS-protected, and covered by the
BAA. Do not describe it as "de-identified" in member-facing or marketing copy;
the accurate phrasing is "scores and dates under a one-way key, no name and no
responses." The raw responses + patient name in `assessment_results` hard-delete
30 days after completion; the score-series persists to power progress trends.

---

## 8. Cross-references

- MODEL-REGISTRY.md, every AI-calling file (file, endpoint, model, purpose).
  Update in the same commit when a tool gains, loses, or changes a model.
- Per-tool QA checklists (e.g. qa-termination-test.md) with a pointer comment in
  the tool's HTML.

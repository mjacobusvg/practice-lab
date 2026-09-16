# Think Beyond Practice — AI Model Registry

**Purpose:** One place to see which tool calls AI, through which endpoint, on which model. When Anthropic (or OpenAI) retires a model, this is a lookup, not a hunt.

**How the system works (read this once):**
- Tools do not talk to AWS. There is no Bedrock in the path. Every AI call goes to `api.anthropic.com` (or `api.openai.com` for embeddings) directly.
- Each tool's model is a **text string in that tool's own code** (the `model:` field in its fetch body). The proxy passes it straight through.
- Both proxies **default** to `claude-haiku-4-5-20251001` if a tool sends no model. So a tool that omits `model:` is automatically current.
- **To change a model:** find the string, change it, redeploy the file. No dashboard, no settings, no infrastructure.

**Last full audit:** 2026-06 (Sonnet 4 retirement). Current Anthropic models in use: `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.

---

## AI-calling surfaces

| File | Endpoint | Model(s) | Purpose |
|---|---|---|---|
| pm-chart-coder.html | clinical-proxy-stream | claude-sonnet-4-6 (x2: MDM extract + verify), claude-haiku-4-5-20251001 (x2: preflight + audit) | Documentation audit + E/M coding (LLM extracts facts, deterministic JS maps to MDM levels/code) + follow-up chat. PHI tool — full note is pasted in. |
| pm-monitoring-protocol.html | clinical-proxy | claude-sonnet-4-6 | Monitoring counseling generation |
| practice-lab-billing.html | anthropic-proxy | claude-sonnet-4-6 (x9), claude-haiku-4-5-20251001 (x3) | Billing sim, Angela rep, drills |
| pm-interaction-checker.html | anthropic-proxy | claude-sonnet-4-6 | Interaction analysis |
| practice-lab-clinical.html | anthropic-proxy | claude-sonnet-4-6 (x2: simulated-patient turn + MI debrief) | Clinical Simulation Lab. Simulated patients only, NOT a PHI tool. Patient turn returns JSON (speech + hidden readiness/alliance state); the debrief is a separate call that codes the transcript against MITI-style counts and must quote the clinician verbatim. Logs `tool: Clinical Simulation Lab` with a per-scenario `mode`, so cost per training session is measurable. |
| pm-clinical-note-builder.html | clinical-proxy-stream | claude-sonnet-4-6 (up to x4: preflight cards + assess draft + QA review + therapy blurb) | Psychotherapy add-on + assessment generation from pasted HPI (PHI tool). Does not generate HPI or Plan. Accepts a one-button HPI handoff from the HPI Generator via sessionStorage. |
| pm-hpi-generator.html | clinical-proxy-stream | claude-sonnet-4-6 (draft HPI; optional/auto verify pass; Setup-wizard template build) | Drafts the HPI from raw as-you-go notes using the clinician's Vault template (vault_profile: hpiTemplateEval / hpiTemplateFollowup). Verify pass is opt-in for typed input, automatic for pasted transcripts. PHI tool. |
| pm-ai-scribe.html (+ shared note-engine.js) | clinical-proxy-stream | claude-sonnet-4-6 (draft HPI, verify/MSE/ROS pass, assessment draft, assessment QA review, therapy blurb) + claude-haiku-4-5-20251001 (preflight cards, Plan fill) | Ambient scribe: full note pipeline (HPI → verify+MSE+ROS → preflight → assessment → therapy add-on → plan). Per-call model is chosen via callAPI's 5th arg (default Sonnet). Plan (pure template-fill) runs on Haiku after an A/B tie. Preflight runs on Haiku (speed; on trial — A/B hit the mandatory dx card but was slightly thinner). Verify is silent-by-default (fixes what it can without narrating) but MUST still flag a genuine unresolvable question; on Sonnet (Haiku scrubbed genuine questions in A/B). PHI tool. |
| pm-letter-generator.html | clinical-proxy | claude-haiku-4-5-20251001, claude-sonnet-4-6 | Letter generation |
| pm-termination-workflow.html | clinical-proxy | claude-haiku-4-5-20251001 | Termination package (Haiku is intentional — stays under Netlify 26s timeout) |
| inngest-serve.mjs | api.anthropic direct | claude-sonnet-4-6 (synthesis), claude-haiku-4-5-20251001 (query expansion) | Ask the Archive RAG pipeline |
| extract-templates-background.js | api.anthropic direct | claude-sonnet-4-6 | Admin batch: extracts the reusable template from each source post into template_library.preview + a downloadable PDF. Constrained to reuse only post content (no fabrication). |

## Proxies

| File | Default model | Notes |
|---|---|---|
| anthropic-proxy.js | claude-haiku-4-5-20251001 | Non-PHI (Practice Lab, chat tools). Logs usage to `tool_usage` with account_email + tier (from the signed token), model, real token counts, and est cost. |
| anthropic-proxy-demo.js | claude-haiku-4-5-20251001 | Public Practice Lab demo (unauthenticated). Logs anonymous usage rows with token counts + cost. |
| clinical-proxy.js | claude-haiku-4-5-20251001 | PHI tools (Letter Gen, Note Builder, Termination, Monitoring). Streams from Anthropic; logs USAGE METADATA ONLY (counts + cost + email/tier), never content. Covered by Anthropic API BAA. |
| clinical-proxy-stream.mjs | claude-haiku-4-5-20251001 | Streaming PHI proxy. Tees the passthrough stream to read token counts; logs usage metadata only (counts + cost + email/tier), never content. Wraps large (>~4096-char) system prompts in a **1-hour prompt-cache** block (`cache_control` ephemeral, ttl 1h) — chosen from real traffic (notes cluster ~26 min apart, ~75% within an hour). `est_cost_usd` is cache-aware (writes 2x, reads 0.1x); `input_tokens` logs total input incl. cache tokens. Verify caching via `cache_read_input_tokens` in the Anthropic usage. |

## Prompt caching on Bedrock (AWS case 178934455100974, Sept 2026)

Caching was working all along and visible on the bill (Sonnet at roughly 41% of the uncached
estimate) but was invisible to our own metering, which made `est_cost_usd` overstate Sonnet by
about 2.4x. AWS Premium Support answered three things; all three are now implemented in
`aws-lambda/clinical-proxy-stream-bedrock.mjs` and `aws-lambda/clinical-proxy-bedrock.mjs`.

**1. The cache counters are not final on `message_start`.** That is where both proxies were
reading them, and there they are absent or zero. The finalized counts arrive later, in
`message_delta.usage` and in `amazon-bedrock-invocationMetrics`, which Bedrock appends to the
final chunk and which is authoritative. The old parser did receive that final chunk, parsed it
successfully, matched none of its branches, and dropped it. Both proxies now feed every event
to `readUsage()`, and Bedrock's own metrics win over the Anthropic-shaped numbers.

**2. Cached input is counted separately from `input_tokens`.** The real total is
`input_tokens + cache_read + cache_write`, and the three parts bill at different rates
(non-cached 1x, read 0.1x, write 1.25x on a 5 minute TTL or 2x on a 1 hour TTL).

**3. `ttl: "1h"` is supported on both Sonnet 4.6 and Haiku 4.5.** The Netlify predecessor used
it, chosen from real traffic (calls cluster ~26 min apart, ~75% of reuse inside an hour). The
Bedrock port silently dropped the ttl **while keeping the 2x one-hour write multiplier in the
cost formula**, so we were buying five minute caching and pricing one hour caching. The ttl is
restored rather than the multiplier lowered, because at a 26 minute gap the hour is genuinely
cheaper: `2.00x + 0.10x` beats `1.25x + 1.25x`, and the gap widens with every further call.

**The per-model checkpoint minimum (separate from the case, and narrower than it first
looked).** The minimum size for a cache checkpoint is per model and differs fourfold:
**Sonnet 4.6 needs 1,024 tokens, Haiku 4.5 needs 4,096.** Below the minimum the checkpoint is
silently discarded. Our threshold was 4,096 **characters**, roughly 1,170 tokens, so a Haiku
prompt between about 4,096 and 14,300 characters was marked cacheable and then thrown away by
Bedrock. `cacheableSystem()` now takes the model and uses the real per-model minimum.

**This was a latent bug, not an active one, and it does NOT explain Haiku's billing.** Measured
against the live prompts in `note-engine.js`, nothing was ever in the broken window:

| prompt | model | chars | ~tokens | floor | marked? |
|---|---|---|---|---|---|
| ASSESS_SYS | Sonnet | 32,197 | ~9,200 | 1,024 | yes, caches |
| THERAPY_SYS | Sonnet | 19,598 | ~5,600 | 1,024 | yes, caches |
| REVIEW_SYS | Sonnet | 9,734 | ~2,780 | 1,024 | yes, caches |
| MSE_SYS | Sonnet | 3,290 | ~940 | 1,024 | no, below threshold either way |
| PREFLIGHT_SYS | Haiku | 20,867 | ~5,960 | 4,096 | yes, caches |
| PLAN_SYS | Haiku | 3,066 | ~880 | 4,096 | no, below threshold either way |

An earlier version of this section claimed every Haiku checkpoint we ever sent was discarded,
and that this was why Haiku bills at ~110% of the uncached estimate. That was wrong. The fix is
still worth having, because the window reopens the moment a Haiku prompt grows past 4,096
characters without reaching 4,096 tokens (PLAN_SYS is one edit away from it), but Haiku's
billing needs a different explanation. See below.

**The open question: writes with no reads.** The first session after the fix produced seven
calls, every one of them a cache WRITE and not one a cache READ:

    mode            model    fresh in   wrote   read
    prep_followup   sonnet       2,534   3,758      0
    draft           sonnet       4,053   8,453      0
    audit           sonnet       5,282   2,252      0
    (preflight)     haiku        4,178   4,779      0
    ...

That is expected for a single session, because each mode has its own system prompt and each was
called once, so every one was a first write by construction. It is NOT yet evidence that caching
pays. A write costs 2x the base input rate and a read costs 0.1x, so a prompt that is written
and never read is strictly more expensive than not caching it at all.

The structure is right for caching to hit: all six system prompts are module-level constants in
`note-engine.js` interpolating only `VOICE`, itself a constant, so they are byte-identical on
every call, for every clinician, and the Bedrock cache is account-scoped. The second Scribe
session inside the same hour should therefore show reads. **Until a session shows non-zero
`cache_read_tokens`, treat caching as unproven.** The check:

```sql
select model, mode, count(*),
       sum(cache_creation_tokens) as wrote,
       sum(cache_read_tokens)     as read
from public.tool_usage
where usage_source = 'bedrock-metrics'
group by model, mode order by 1,2;
```

A plausible reading of Haiku's ~110%, consistent with the above but not yet confirmed:
PREFLIGHT_SYS is the only cached Haiku prompt and it runs about once per session, so Haiku may
be paying the 2x write premium and collecting few reads. If reads stay at zero for Haiku across
sessions, the answer is to stop caching that prompt, not to tune the TTL.

**Verifying it, without model invocation logging.** AWS confirmed the CloudWatch runtime
metrics under `AWS/Bedrock` dimensioned by `ModelId` are token counts only, with no request or
response content, so they are safe to use under the BAA where invocation logging is not:

    CacheReadInputTokenCount / (InputTokenCount + CacheReadInputTokenCount + CacheWriteInputTokenCount)

`public.tool_usage` also now carries `cache_creation_tokens`, `cache_read_tokens`, `cache_ttl`
and `usage_source`, so the same question is answerable in SQL. `input_tokens` keeps its old
meaning (the total including cache tokens) so existing dashboards do not move. `usage_source`
records which event the counts came from, so a real zero is distinguishable from a call that
was metered blind. NULL in these columns means unknown, not zero, and every row written before
Sept 2026 is genuinely unknown.

Offline tests: `node test/bedrock-usage-checks.mjs`. It also fails if the two lambda copies
drift apart, which matters because each is pasted into its Lambda by hand.

## Usage tracking (tracking overhaul, 2026-07)

All AI-calling surfaces log one row to `public.tool_usage` via `_lib/usage.js`
(`logUsage`) — or an inlined mirror in the `.mjs` files, which cannot require
`_lib`. Each row carries `account_email` + `tier` (from the caller's signed
session, when present), `model`, `input_tokens`, `output_tokens`, and
`est_cost_usd` (computed from a per-model price table in `_lib/usage.js`).
The clinical proxies log token COUNTS only, never message content. Cost prices
live in `MODEL_COST_PER_MTOK` in `_lib/usage.js` (and are duplicated inline in
`clinical-proxy-stream.mjs` and `inngest-serve.mjs`); keep the three in sync.
Page views are logged to `public.page_views` by `log-view.js` (email + tier +
path from the signed token). Instrumented AI paths: the four proxies above,
`chart-coder-background.js` (3 Sonnet passes, summed), and `inngest-serve.mjs`
(Ask the Archive: query expansion + synthesis + source descriptions).

## Embeddings (separate lifecycle — not affected by Anthropic chat-model retirements)

| File | Provider/model | Purpose |
|---|---|---|
| inngest-serve.mjs | OpenAI text-embedding-3-small | Forum post vector embeddings for Ask the Archive |

## Not AI tools (no model calls)

pm-lai.html (deterministic), pm-crisis-safety-plan.html (crisis-resources lookup), pm-hipaa-hub.html (user-tool-data storage), practice-lab-private-practice.html (the `model:` field there is a business/income model object, not AI), ask-archive.js (Supabase + SES only — the RAG model lives in inngest-serve.mjs), and the **Assessment Suite** — pm-assessment-suite.html, assessment.html, and assessment-create/fetch/submit/list/retrieve.js — which scores validated screeners deterministically in assessment-instruments.js with no model call (the only outbound call is to send-document for optional email-link delivery).

---

## When a retirement email arrives

1. Note the retired model string (e.g. `claude-sonnet-4-20250514`).
2. Search the repo for that exact string across all `.html` and `.mjs`/`.js` files.
3. Replace with the recommended successor (same-price drop-in when offered).
4. Redeploy each changed file. Re-test any tool whose model changed.
5. Update this registry.

**There is nothing to change in AWS or any console — the model is always just a string in the code.**

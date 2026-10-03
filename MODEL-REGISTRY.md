# Think Beyond Practice — AI Model Registry

**Purpose:** One place to see which tool calls AI, through which endpoint, on which model. When Anthropic (or OpenAI) retires a model, this is a lookup, not a hunt.

**How the system works (read this once):**
- There are two paths, and which one a tool uses is decided by PHI (see `BAA-AND-PHI-ROUTING.md`):
  - **Clinical (PHI) tools** call the AWS Lambda Function URLs (`aws-lambda/clinical-proxy-stream-bedrock.mjs`, `aws-lambda/clinical-proxy-bedrock.mjs`), which invoke Claude on **Amazon Bedrock** under the AWS BAA. The tool sends a logical model name (`claude-sonnet-4-6` / `claude-haiku-4-5-20251001`); the Lambda maps it to a Bedrock inference-profile ID held in its `BEDROCK_MODEL_SONNET` / `BEDROCK_MODEL_HAIKU` env vars. Any name not in the Lambda's `ALLOWED_MODELS` silently runs on Haiku.
  - **Non-PHI tools** (Practice Lab, Ask the Archive, admin batch jobs) call `api.anthropic.com` directly or through the Netlify `anthropic-proxy*.js` functions (and `api.openai.com` for embeddings).
- Each tool's model is a **text string in that tool's own code** (the `model:` field in its fetch body).
- Both Lambdas and both Netlify proxies **default** to `claude-haiku-4-5-20251001` if a tool sends no model.

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
| ingest-cms-doc-upload-background.js | api.anthropic direct | claude-sonnet-4-6 | Admin: extracts text from an uploaded public CMS PDF into the "CMS Reference" space. Not PHI. |
| template-analyze.js | api.anthropic direct | claude-haiku-4-5-20251001 | Template analysis. |
| fact-checker.html, archive-diagnostics.html, practice-lab-clinical-harness.html | anthropic-proxy | claude-sonnet-4-6 / claude-haiku-4-5-20251001 | Non-PHI tools and admin diagnostics. |
| practice-lab-demo.html | anthropic-proxy-demo | (proxy default) | Public Practice Lab demo. |
| note-deidentifier.html, chart-coder-trial.html, note-builder-trial.html | Bedrock Lambda | claude-sonnet-4-6 / claude-haiku-4-5-20251001 | PHI-capable tools and trial copies. |

## Proxies

| File | Default model | Notes |
|---|---|---|
| anthropic-proxy.js | claude-haiku-4-5-20251001 | Non-PHI (Practice Lab, chat tools). Logs usage to `tool_usage` with account_email + tier (from the signed token), model, real token counts, and est cost. |
| anthropic-proxy-demo.js | claude-haiku-4-5-20251001 | Public Practice Lab demo (unauthenticated). Logs anonymous usage rows with token counts + cost. |
| aws-lambda/clinical-proxy-bedrock.mjs (`tbp-clinical-proxy`) | claude-haiku-4-5-20251001 | **Live PHI path** (Bedrock, AWS BAA). Non-streaming clinical tools. Pasted into its Lambda by hand. |
| aws-lambda/clinical-proxy-stream-bedrock.mjs (`tbp-clinical-proxy-stream`) | claude-haiku-4-5-20251001 | **Live PHI path** (Bedrock, AWS BAA). Streaming clinical tools; 1-hour prompt cache (see below). Pasted into its Lambda by hand. |

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

**Confirmed working, 2026-09-16.** The first session after the deploy produced seven cache
writes and no reads, which is what one session must look like: each mode has its own system
prompt and each ran once, so every call was a first write. The second session, eleven minutes
later, hit the cache on all seven calls, and the read sizes matched the earlier writes exactly
(3758, 8453, 2252, 4779, 4398, 7282, 2181), confirming the prefix is byte-stable across
sessions and clinicians.

Measured against what the same calls would have cost with no caching:

| phase | calls | actual | if uncached | |
|---|---|---|---|---|
| session 1, writing | 7 | $0.339 | $0.249 | **+36%** |
| session 2, reading | 7 | $0.148 | $0.229 | **-35%** |
| both | 14 | $0.487 | $0.478 | +1.9% |

So the first note in each cache hour is a setup cost and every note after it is about 35%
cheaper. Two notes break even; the saving compounds from the third on, asymptotically -35%.
**The lever is notes per hour, not the configuration.** Three notes in an hour lands near -27%.
A single isolated note an hour is +36%, i.e. caching costs money. The gap analysis below says
80-97% of repeats fall inside an hour, so normal use is comfortably on the right side.

This also settles the TTL. From 14 days of real traffic:

| model / mode | repeats | median gap | within 5 min | within 1 hr |
|---|---|---|---|---|
| Sonnet (main) | 875 | 0.6 min | 677 | 97% |
| Haiku (main) | 204 | 10.5 min | 81 | 90% |
| Sonnet draft | 19 | 25.1 min | **0** | 84% |
| Sonnet audit | 18 | 25.1 min | **0** | 83% |
| Sonnet prep_followup | 15 | 1.8 min | 10 | 80% |
| Sonnet revise_hpi | 5 | 66.8 min | 0 | 40% |

`draft` and `audit` never once repeat inside five minutes. On the five minute window the Bedrock
port was actually running, those two paid the write premium on every call and never read, which
is real money lost. `revise_hpi` is the one mode that may not clear break-even at any TTL; it is
low volume, so watch it rather than act on it.

**Still open: why Haiku bills at ~110% of the uncached estimate.** Haiku does hit its cache
(4,779 tokens read). No confident explanation yet, and the arithmetic on the obvious one does
not work out. It is now directly measurable from `cache_read_tokens` / `cache_creation_tokens`
rather than inferable, so leave it to accumulate rows.

The standing check:

```sql
select model, coalesce(mode,'(none)') as mode, count(*),
       sum(cache_creation_tokens) as wrote, sum(cache_read_tokens) as read
from public.tool_usage
where usage_source = 'bedrock-metrics'
group by 1,2 order by 1,2;
```

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
`aws-lambda/*-bedrock.mjs` and `inngest-serve.mjs`); keep them in sync.
Page views are logged to `public.page_views` by `log-view.js` (email + tier +
path from the signed token). Instrumented AI paths: the proxies above and `inngest-serve.mjs`
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
4. If the model is used by a clinical tool, also update the Bedrock side, or the tool silently runs on Haiku: add the new name to `ALLOWED_MODELS` and `BEDROCK_ID` in BOTH `aws-lambda/*-bedrock.mjs` files (and their price and cache-minimum tables), paste each into its Lambda, and set `BEDROCK_MODEL_SONNET` / `BEDROCK_MODEL_HAIKU` in the Lambda console to a **US** inference-profile ID (never `global.`). `node test/bedrock-usage-checks.mjs` catches the two copies drifting.
5. Redeploy each changed file. Re-test any tool whose model changed.
6. Update this registry.

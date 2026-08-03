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
| pm-clinical-note-builder.html | clinical-proxy-stream | claude-sonnet-4-6 (up to x4: preflight cards + assess draft + QA review + therapy blurb) | Psychotherapy add-on + assessment generation from pasted HPI (PHI tool). Does not generate HPI or Plan. Accepts a one-button HPI handoff from the HPI Generator via sessionStorage. |
| pm-hpi-generator.html | clinical-proxy-stream | claude-sonnet-4-6 (draft HPI; optional/auto verify pass; Setup-wizard template build) | Drafts the HPI from raw as-you-go notes using the clinician's Vault template (vault_profile: hpiTemplateEval / hpiTemplateFollowup). Verify pass is opt-in for typed input, automatic for pasted transcripts. PHI tool. |
| pm-ai-scribe.html (+ shared note-engine.js) | clinical-proxy-stream | claude-sonnet-4-6 (draft HPI, preflight cards, assessment draft, assessment QA review, therapy blurb) + claude-haiku-4-5-20251001 (verify/MSE/ROS pass, Plan fill) | Ambient scribe: full note pipeline (HPI → verify+MSE+ROS → preflight → assessment → therapy add-on → plan). Per-call model is chosen via callAPI's 5th arg (default Sonnet). The two mechanical template-fill/audit calls (verify, plan) run on Haiku after an A/B test showed parity; the verify pass is intentionally fully silent (empty flags). PHI tool. |
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
| clinical-proxy-stream.mjs | claude-haiku-4-5-20251001 | Streaming PHI proxy. Tees the passthrough stream to read token counts; logs usage metadata only (counts + cost + email/tier), never content. |

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

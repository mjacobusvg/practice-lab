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
| pm-chart-coder.html | anthropic-proxy | claude-sonnet-4-6 (x2) | MDM coding + follow-up chat |
| pm-monitoring-protocol.html | clinical-proxy | claude-sonnet-4-6 | Monitoring counseling generation |
| practice-lab-billing.html | anthropic-proxy | claude-sonnet-4-6 (x9), claude-haiku-4-5-20251001 (x3) | Billing sim, Angela rep, drills |
| pm-interaction-checker.html | anthropic-proxy | claude-sonnet-4-6 | Interaction analysis |
| pm-clinical-note-builder.html | anthropic-proxy | claude-sonnet-4-6 | Psychotherapy add-on + assessment generation from pasted HPI |
| pm-letter-generator.html | clinical-proxy | claude-haiku-4-5-20251001, claude-sonnet-4-6 | Letter generation |
| pm-termination-workflow.html | clinical-proxy | claude-haiku-4-5-20251001 | Termination package (Haiku is intentional — stays under Netlify 26s timeout) |
| inngest-serve.mjs | api.anthropic direct | claude-sonnet-4-6 (synthesis), claude-haiku-4-5-20251001 (query expansion) | Ask the Archive RAG pipeline |

## Proxies

| File | Default model | Notes |
|---|---|---|
| anthropic-proxy.js | claude-haiku-4-5-20251001 | Non-PHI (Practice Lab, Ask the Archive). Logs usage to Supabase. |
| clinical-proxy.js | claude-haiku-4-5-20251001 | PHI tools (Letter Gen, Chart Coder, Interaction Checker). Pass-through, no content logging. Covered by Anthropic API BAA. |

## Embeddings (separate lifecycle — not affected by Anthropic chat-model retirements)

| File | Provider/model | Purpose |
|---|---|---|
| inngest-serve.mjs | OpenAI text-embedding-3-small | Forum post vector embeddings for Ask the Archive |

## Not AI tools (no model calls)

pm-lai.html (deterministic), pm-crisis-safety-plan.html (crisis-resources lookup), pm-hipaa-hub.html (user-tool-data storage), practice-lab-private-practice.html (the `model:` field there is a business/income model object, not AI), ask-archive.js (Supabase + SES only — the RAG model lives in inngest-serve.mjs).

---

## When a retirement email arrives

1. Note the retired model string (e.g. `claude-sonnet-4-20250514`).
2. Search the repo for that exact string across all `.html` and `.mjs`/`.js` files.
3. Replace with the recommended successor (same-price drop-in when offered).
4. Redeploy each changed file. Re-test any tool whose model changed.
5. Update this registry.

**There is nothing to change in AWS or any console — the model is always just a string in the code.**

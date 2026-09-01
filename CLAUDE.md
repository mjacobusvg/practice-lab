# Working rules for this repo (read first)

This project is a set of static HTML/JS tools deployed by **Netlify from the `main`
branch**. There is no build step — editing an `.html` file and pushing to `main` deploys it.
The owner (Michael) often runs **several Claude sessions in parallel** on different changes,
so files on `main` can change underneath you mid-session.

## 1. Read the live `main` version of a file before editing it

ALWAYS fetch and read the current `origin/main` copy of a file immediately before changing
it — never edit from a stored/cached copy in your working tree, which may be stale because
another session already changed that file. Concretely, before any edit:

```
git fetch origin main
git checkout -B main origin/main   # sync working tree to the live main
# now Read the file and make your edits
```

Then commit and push straight to `main` (see rule 2). This turns "two sessions editing the
same file" from a clobber risk into a clean, up-to-date edit.

## 2. Commit and push directly to `main`

Work directly on `main` for normal changes. Do **not** develop on a long-lived feature
branch — the live site is `main`, and the owner wants changes to land there. After editing:

```
git add <file> && git commit -m "..." && git push origin main
```

If `push` is rejected because `main` advanced (a parallel session pushed), do NOT force:
`git fetch origin main` → `git rebase origin/main` → push again. Rebase is normally clean
because different sessions usually touch different files.

**Branches are only for backups.** The one time to use a branch is to park a copy of an old
`main` file as a backup *before* a major change that alters behavior you might want to revert
to. That's the only sanctioned use of a branch here.

### In force: try Scribe changes on the practice copy first

Michael wants Scribe changes tried on a copy before they reach the file members are using.
That copy is NOT a branch (branch deploys do not work here: `auth-gate.js` hardcodes sign-in
to `https://thinkbeyondpractice.com/platform`, so logging in on a branch domain bounces you
back to production). It is three files on `main`, at `/practice`:

| live (members use this) | practice copy |
|---|---|
| `pm-ai-scribe.html` | `ai-scribe-practice.html` |
| `ai-scribe-workspace.html` | `ai-scribe-practice-workspace.html` |
| `note-engine.js` | `note-engine-practice.js` |

The copies reference only each other, so editing them cannot affect the live Scribe. They are
noindexed, disallowed in `robots.txt`, and unlinked.

So: **for a Scribe change Michael wants to try before it goes live, edit the practice copy,
push to `main`, and let him test at `/practice`.** Once he approves it, port the same change
into the live file. An urgent production bug fix still goes straight to the live file.

The build-tag lockstep rules below apply to the LIVE files only. The practice desk pins
`TBP_BUILD` high on purpose so a deploy never fires the update nudge inside it; leave it.

Everything else in this repo still follows rule 2 and goes straight to `main`.

## 3. Deploy = push to `main`

Pushing to `main` triggers the Netlify redeploy. After pushing a front-end change, tell the
owner to **hard-reload** (Cmd/Ctrl+Shift+R) once the build finishes, since a normal reload can
serve the cached old file.

## Build tag + update nudge (bump together every deploy)

The Scribe iframe is cache-busted by a `?v=ambient-NN` build tag. When you change `pm-ai-scribe.html`
or `ai-scribe-workspace.html`, bump that number **and keep three things in lockstep**, all to the
SAME `ambient-NN`:
1. `note-engine.js?v=ambient-NN` and the visible `build ambient-NN` in `pm-ai-scribe.html`, and the
   iframe `&v=ambient-NN` in `ai-scribe-workspace.html` (the existing build tag).
2. `version.json` → `{"build":"ambient-NN"}` (served `no-store`; it is the deployed-build source of truth).
3. `TBP_BUILD = 'ambient-NN'` in `ai-scribe-workspace.html` (the running tab's build constant).

A long-open tab polls `version.json` and shows a "Refresh now" bar when the **notify** build is
numerically newer than `TBP_BUILD`. If you bump the build tag but forget `version.json`/`TBP_BUILD`,
the nudge silently stops working (or, if only one moves, misfires). Move all three together.

### `notify` — only nag for updates worth interrupting a clinical session

`version.json` carries a SECOND tag: `{"build":"ambient-NN","notify":"ambient-MM"}`. `build` is the
cache-bust and always bumps every deploy (in lockstep as above). `notify` is the newest build we
actually want open tabs to refresh onto, and the refresh bar fires only when `notify` (not `build`)
is numerically newer than the tab's `TBP_BUILD`. Because minor tweaks ship several times a day, the
default is:
- **Minor tweak:** bump the `build`/lockstep tags only. Leave `notify` unchanged. Deploys silently;
  a long-open tab picks it up on its next natural reload, no nag.
- **Important fix users should get now** (a live bug, data-loss fix, workflow change): ALSO set
  `notify` to the new build number. Then lagging tabs get the bar.

If `notify` is absent the nudge falls back to comparing `build` (old always-nag behavior), so never
delete it; just leave it in place and only advance it when a deploy is worth interrupting people for.

## Notes

- **Before proposing or beginning substantial new product functionality, read `ROADMAP.md`**
  and make sure the work fits the current focus and clears the NOT NOW gate. `ROADMAP.md` is
  the executive statefile (what we're proving, building, and deliberately not building now);
  the current strategic priority is *improve/integrate/prove/market what already exists*, not
  add breadth. Ideas that are not current work live in `FUTURE-OPPORTUNITIES.md` (preserved,
  not approved for build) — add good ideas there rather than starting them.
- **PHI now flows through AWS (Bedrock/Lambda/SES) under the AWS BAA and Azure under the Microsoft
  BAA — NOT through Netlify or a direct Anthropic API.** Clinical text tools call AWS Lambda Function
  URLs (`tbp-clinical-proxy-stream` / `tbp-clinical-proxy`) which invoke Claude via **Amazon Bedrock**
  (`us.anthropic.claude-sonnet-4-6`, `us.anthropic.claude-haiku-4-5-20251001-v1:0`); transcription
  goes to Azure AI Speech via `tbp-azure-transcribe`. **Read `BAA-AND-PHI-ROUTING.md` before touching
  any clinical data path, BAA, subprocessor page, or privacy policy** — it is the source of truth for
  which BAA covers what and how every kind of PHI is routed. The Netlify `clinical-proxy*.mjs` /
  `azure-transcribe*.mjs` files are OFF-BAA rollback-only; do not point traffic at them or at
  `api.anthropic.com`. See `MODEL-REGISTRY.md` for the per-tool model list.
- `CLINICAL-NOTE-GENERATOR-ARCHITECTURE.md` is the living design doc for the HPI Generator /
  Note Builder / coder pipeline. §0.3 / §0.3.1 hold the governing rule on what may be
  hardcoded vs. what must come from the clinician's Vault template — read it before changing
  any assessment or HPI prompt.
- `LETTER-STANDARDS-REVIEW.md` governs the Letter Generator's clinical letter templates.
  They live in the Supabase table `tbp_letter_standards`, not in the HTML, so editing a letter
  is a SQL version bump, not a code change. Read it before touching any template or its
  editorial review, and confirm before any Supabase write to those production rows.
- `MARKETING-SPINE.md` is the **canonical, approved marketing narrative** for the AI Scribe and
  the Think Beyond Practice membership. Read it before drafting ANY pitch, ad, post, reply,
  email, landing page, or sales copy about the Scribe/membership, and reuse it rather than
  reinventing the pitch. It holds the master narrative, the compact (Facebook/forum) cut, and
  the landing-page headline. House style: no em-dashes; lead with the **audit** differentiator;
  do not claim "no other scribe audits notes" as an absolute.
- `CLINICAL-OS-STRATEGY.md` is the **living product-direction doc** for where TBP is heading (the
  "operating system for psychiatric practice" thesis: the Scribe as encounter-context layer that
  orchestrates the existing tools). It is a starting point, NOT a frozen spec or permission to
  build everything in it. Read it before any Scribe-orchestration, cross-tool-handoff, clinical-
  guidance/evidence, forms/PA, or lab-ordering work. Its own rules bind: inspect what already
  exists in the repo before building, detect cheaply and call AI only when needed, keep
  structured data / retrieved evidence / AI synthesis separate, and surface tradeoffs to Michael
  before consequential product decisions.
- **The community is NOT on Circle anymore.** TBP runs its own platform (`platform.html` +
  `netlify/functions/`), with members and contacts in Supabase (`public.contacts`, tiers
  `free` / `forum` / `full`). The many `Circle`-named files and the Circle MCP connector are
  **legacy** — do not treat them as the live system. Member **broadcasts are email**, sent via
  `netlify/functions/broadcast-send.js` (AWS SES to `public.contacts`; audiences `all` /
  `members` / `nonmembers` / `free` / `forum` / `full`; supports `test_email` preview and
  `dry_run`) from the admin area in `platform.html`, with scheduling via
  `send-scheduled-broadcasts.js`. Never route a broadcast, post, or member action through Circle.

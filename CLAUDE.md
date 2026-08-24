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

## 3. Deploy = push to `main`

Pushing to `main` triggers the Netlify redeploy. After pushing a front-end change, tell the
owner to **hard-reload** (Cmd/Ctrl+Shift+R) once the build finishes, since a normal reload can
serve the cached old file.

## Notes

- Clinical tools stream PHI through `clinical-proxy-stream.mjs` (BAA-covered); models are
  `claude-sonnet-4-6` and `claude-haiku-4-5-20251001`. See `MODEL-REGISTRY.md` for the
  authoritative per-tool model list — update it when you change a tool's model usage.
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

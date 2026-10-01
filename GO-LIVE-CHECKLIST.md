# Go-live checklist: multi-page marketing site

Turning the draft multi-page site (built from the live `index.html`) into the live
site. Nothing here fires until Michael says go. Work on `main`, small commits, and
because this is a **major change, branch-back up the old `index.html` first**
(the one sanctioned use of a branch per `CLAUDE.md`). Companion docs:
`SITE-RESTRUCTURE-MAP.md` (what lives where), `PRODUCT-ARCHITECTURE-AND-NAMING.md`,
`MARKETING-SPINE.md`.

Draft pages in scope: `home.html`, `pricing.html`, `about.html`, `ai-scribe.html`,
`community.html`, `practice-lab.html`. Live pages that join at go-live:
`credentialing-concierge-preview.html`, `insights.html`.

---

## 0. Pre-flight (mostly Michael, in a real browser)

These could not be verified from the build sandbox (the proxy blocks the live
domain, and there is no test-account session here).

- [ ] **Forum-preview on a real phone:** does the restored community window below
      the hero fit and scroll on iOS and Android? (Sandbox could not load the
      backend iframe.)
- [x] **Join → Stripe click-through:** VERIFIED 2026-09-30 in a real browser. "Join
      Full — $119/mo" reaches the correct Stripe checkout (`Subscribe to TBP
      Membership: Full, $119/month`) after create-account + one-time email confirm.
      Email confirmation is on by design (security). Fixes landed during this test:
      the onboarding tour no longer pre-empts checkout, the install-app slide is now
      iOS-accurate, and an existing email is routed to Sign in instead of a
      misleading "account created". Still worth a one-off check of the
      `forum_monthly_50` and `/start-scribe` variants.
- [ ] Final human read of each of the six pages at desktop and phone width.

## 1. Backup (do first, before any overwrite)

- [ ] Branch-back up the current live homepage:
      `git fetch origin main && git checkout main && git checkout -b backup/index-prelaunch-YYYYMMDD && git push -u origin backup/index-prelaunch-YYYYMMDD && git checkout main`
      (Branch is a backup only; all real work stays on `main`.)

## 2. The swap (index.html becomes the new home)

- [ ] Sync main, then overwrite: `cp home.html index.html`. `index.html` is what
      `/` serves, so this makes the reshaped page the live homepage.
- [ ] Redirect the draft URL so it is not a duplicate: add a 301 `from = "/home.html"`
      `to = "/"` in `netlify.toml`. (Keep `home.html` on disk as the redirect source,
      or delete it and rely on the redirect — pick one and be consistent.)
- [ ] Confirm the new `index.html` canonical / `og:url` / `twitter:url` point to
      `https://thinkbeyondpractice.com/` (not `/home.html`).

## 3. Remove the draft guards (each of the six pages)

- [ ] Delete `<meta name="robots" content="noindex, nofollow" />` from the new
      `index.html` and from `pricing.html`, `about.html`, `ai-scribe.html`,
      `community.html`, `practice-lab.html` so Google can index them.
- [ ] Remove the `<!-- DRAFT of ... noindex until launch -->` comment from each
      (and fix the stray one in `practice-lab.html` that reads "DRAFT of the /about
      page").

## 4. Routing and navigation

Clean routes already wired and serving explainers (verified): `/pricing`→`pricing.html`,
`/about`→`about.html`, `/community`→`community.html`, `/ai-scribe`→`ai-scribe.html`
(all 200). `/practice-lab`→`practice-lab-hub.html` stays the gated member hub; the
marketing nav points at `/practice-lab.html`.

- [ ] **Decide nav path style:** either keep the working `.html` links, or switch
      nav/footer to the clean routes (`/ai-scribe`, `/community`, `/practice-lab.html`
      stays since `/practice-lab` is the hub). Apply the same choice across all pages.
- [ ] **Unify Credentialing + Insights nav** to the new multi-page nav + hamburger.
      This was deferred specifically because doing it pre-launch would point live
      pages at noindex drafts; at go-live that risk is gone. Copy the `<nav>` block,
      the `.nav-toggle` base rule, and the `@media (max-width:700px)` hamburger CSS
      from a draft page into `credentialing-concierge-preview.html` and
      `insights.html` (bring the CSS, not just the markup).
- [ ] **Old anchor links:** `home.html` has `#ai-scribe`, `#pricing`, `#try-archive`
      but not `#about` or `#platform`. Confirm nothing external relies on `/#about`
      (About is now its own page); if it might, add a redirect or an `id`.

## 5. SEO / metadata

- [ ] Update `sitemap.xml`: add `/pricing`, `/about`, `/ai-scribe`, `/community`,
      `/practice-lab.html`; confirm `/` (home) is present and dated.
- [ ] `robots.txt`: no change needed — the new pages are already under `Allow: /`
      and were only held back by the `noindex` meta. Confirm none are mistakenly
      disallowed.
- [ ] Spot-check each page's `<title>`, meta description, and `og:` tags read as the
      live page (they were written for it, but confirm none say "draft").

## 6. Cleanup

- [ ] Delete the stale superseded drafts: `home-v2.html`, `about-v2.html`,
      `pricing-v2.html` (these predate this rebuild; `pricing-v2` still carries the
      old "ANCC ~Oct 2026" copy).
- [ ] Grep for any lingering links to `*-v2.html` before deleting (should be none).

## 7. Post-swap verification (after the deploy builds)

- [ ] Hard-reload `/` and every nav destination; confirm the multi-page nav and the
      mobile hamburger work on all pages, including Credentialing and Insights.
- [ ] Re-run the resolve-link audit against the live site (every nav, demo, signup,
      and purchase link lands where expected; no link dumps a logged-out visitor on
      the sign-in wall except the intentional Members link).
- [ ] Click each commerce path once (the three Stripe one-time products, `?join`,
      `?free`, `?buy`, the two plans, `/start-scribe`).
- [ ] Tell Michael to hard-reload (Cmd/Ctrl+Shift+R); a normal reload can serve the
      cached old homepage.

## 8. After live (separate track)

- [ ] Build the **visual platform tour** (the working-window v2 of the hero map:
      four choices that swap the window to a real example per area, forum preview as
      the Community view, clinical tools shown under Clinical work, coming features
      labeled). Spec it first; do not start until the current site is live.

---

### Status going in
- Done: link audit clean, mobile nav fixed (hamburger), no horizontal overflow, the
  four-part map in the first screen, forum preview restored below it, and the copy
  passes (audience, honest claims, CE-when-accredited, Autopilot live).
- Needs Michael before go: §0 pre-flight (phone forum-preview, Join→Stripe).
- Go-live itself (§1–§7) is one coordinated pass on Michael's word.

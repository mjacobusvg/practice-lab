# Site restructure map (marketing site)

Working plan for splitting the single-page `index.html` into a small multi-page
marketing site, without losing anything. Started 2026-09-27.

**Why this doc exists.** A draft homepage (`home-v2.html`) silently dropped real
content and a revenue product from the pricing. This map is the safety check: every
section, product, testimonial, and working signup path on the current live homepage
is listed here with an explicit destination. Nothing gets dropped by omission again.
If an item is going to be cut, it says so on purpose, with a reason.

**Governing docs:** `PRODUCT-ARCHITECTURE-AND-NAMING.md` (naming), `MARKETING-SPINE.md`
(narrative + the present-tense capability sequence), `CLINICAL-OS-STRATEGY.md` (the
workspace / encounter-context-layer vision). House style: no em-dashes.

**Naming rules that bind this restructure:**
- Do NOT rename the product or introduce a "Workspace" nav/URL name yet. Keep the
  existing **AI Scribe** route. Make its page unmistakably **Think Beyond AI: your AI
  scribe and clinical assistant**, with Scribe as one capability on it.
- "AI scribe" stays only as the category term. Everywhere else, name the capability
  or say "the workspace." Never "six modules" / "six layers."
- Visitor-facing sequence (present tense, from the spine): understand the record,
  prepare the visit, reason through the case, document the care, audit before signing.
  Read -> Prepare -> Reason -> Interview is the DEV story (Interview still coming), not
  the visitor pitch.

---

## Pages and nav (decided 2026-09-27)

Home lives behind the logo (no "Home" text item). Members and Join are account
actions on the right. Everything else is a visible route.

Nav: **[logo -> Home] · AI Scribe · Practice Lab · Credentialing · Community ·
Pricing · About · Insights · [Members] · [Join]**

| Page | Route | Job |
|---|---|---|
| Home | `/` (behind logo) | Convince of the core idea and route. Not a catalog of everything. |
| AI Scribe (Think Beyond AI) | keep `#ai-scribe`, promote to `/ai-scribe` | The workspace deep-dive: capabilities by Before/During/After, the roadmap, the arc. |
| Practice Lab | `/practice-lab` (-> `practice-lab-hub.html`), demo `/practice-lab-demo.html` | Simulation-first training + the free demo. |
| Credentialing | `/credentialing-concierge-preview.html` | Hub + Autopilot, pricing, preview. |
| Community | `/community` (new) | Forum explainer (free access vs $50 participation) + the working Ask the Archive experience. Home links here. |
| Pricing / Products | `/pricing` (new) | The single authoritative commerce page: all four offerings + ROI + founding rate. |
| About | `/about` (new) | Full founder story, why it is different, the problem, value-stack. Trust page. |
| Insights | `/insights.html` (exists) | Keep as a visible route. |
| Members app | `/platform` (unchanged) | Not a marketing page. |

Existing homepage anchor links (`#ai-scribe`, `#platform`, `#pricing`, `#about`,
`#try-archive`) must keep resolving, people may have them bookmarked or linked.

Site-wide (every page): promo bar, nav, footer, email capture, cookie banner +
analytics/consent.

---

## Master element map (every section on the live `index.html`)

Home treatment key: FULL = lives here in full · SUMMARY = short version, links to its
page · TEASER = one-line hook + link · SITE = appears on every page · CUT = removed on
purpose (reason given).

| # | Live element | Home treatment | Primary destination |
|---|---|---|---|
| 1 | Founding-rate promo bar ($119 -> $149 countdown) | SITE | Site-wide sticky |
| 2 | Nav | SITE (new multi-page nav) | Site-wide |
| 3 | Hero (idea-first + peek window) | FULL (reworked to idea-first) | Home |
| 4 | Hero stat row (14yr / PMHNP / Fall '26 ANCC / 15-day) | SUMMARY (trust strip) | Home; ANCC detail -> Pricing |
| 5 | AI Scribe spotlight: lede + "think beyond the scribe" | SUMMARY | AI Scribe page (full) |
| 6 | Before/During/After capability loop | SUMMARY (3-moment band) | AI Scribe page (full) |
| 7 | AI roadmap tiers (Next / Roadmap / Exploring) | CUT from home | AI Scribe page |
| 8 | "Built with the people who use it" ask (mailto) | CUT from home | AI Scribe page |
| 9 | "Yes it asks a little of you up front" reassurance | CUT from home | AI Scribe page |
| 10 | Platform grid, 6 capability cards | SUMMARY (links out) | Practice Lab -> `/practice-lab`; Clinical tools/Manager -> `/practice-manager-demo`; Ask the Archive -> Community; Forum -> Community; Credentialing -> `/credentialing-concierge-preview.html`; CE -> `thinkbeyondeducation.org` |
| 11 | "Six integrated layers" heading | CUT (naming violation) | replace with capability framing |
| 12 | "What This Replaces" ROI ($ figures, all that for $119) | TEASER (one value line) | Pricing page (full) |
| 13 | Email capture ("Not ready to join yet?") | SITE (footer band) | Site-wide |
| 14 | Practice Lab "See it working" free demo | TEASER (door) | Practice Lab page |
| 15 | Ask the Archive interactive box (Q chips + email gate) | TEASER (link only) | Community page (full working experience) |
| 16 | "Why It's Different" (4 differentiators) | SUMMARY (condensed) | About page (full) |
| 17 | Testimonials (Haley, Abieyuwa x2, Isabella) | FULL (proof) | Home; also About |
| 18 | About / founder story + photo + credentials | SUMMARY (trust strip + link) | About page (full) |
| 19 | "The Problem" (information vs judgment) | CUT from home | About page |
| 20 | "After the courses... now what?" | CUT from home | About page |
| 21 | Founder value-stack callout quote | CUT from home | Pricing (it is a value-for-price claim) |
| 22 | Footer links | SITE | Site-wide footer |
| 23 | Cookie banner + gtag/fbq consent | SITE | Site-wide |

Nothing above is dropped from the SITE. "CUT from home" means it moves to a named
page, not that it disappears.

---

## Commerce and signup paths (MUST all stay reachable): the check I failed before

Every one of these is a live way someone gives money or signs up. Each must appear on
at least the page named, and none may vanish.

| Offering / action | Price | Link | Must appear on |
|---|---|---|---|
| Free forum access | $0 | `/platform.html?join` | Home, Pricing, nav |
| Free account | $0 | `/platform.html?free` | Pricing |
| Forum membership | $50/mo | `/platform.html?join&plan=forum_monthly_50` | Pricing |
| Full membership | $119/mo (-> $149) | `/platform.html?join&plan=full_monthly_119` | Home, Pricing, nav, promo bar |
| AI Scribe free trial | $0 / 2 wk | `/start-scribe` | Home, AI Scribe page |
| AI Scribe demo (no clock) | $0 | `/ai-scribe-workspace.html?demo=1` | Home, AI Scribe page |
| Foundational Documents Pack | $249 one-time | Stripe `bJe7sMeVnaVDah5edd3Ru03` | Pricing |
| Complete Practice Toolkit | $699 one-time | `/platform.html?buy=723c2236-4d83-452c-972f-952b4810abbe` | Pricing |
| Credentialing Hub | $299 one-time | Stripe `8x24gAeVngfXbl92uv3Ru00` | Pricing, Credentialing page |
| Credentialing Autopilot | $599 one-time | Stripe `28EcN66oRgfX3SH0mn3Ru01` | Pricing, Credentialing page |
| Newsletter email capture | - | `#email-capture-form` | Site-wide band |
| Ask the Archive email gate | - | `#archive-access-form` | Community page / Home try-it |
| Members login | - | `/platform` | nav |
| Practice Toolkit (footer) | $699 | `/platform.html?buy=723c2236-...` | footer |
| CE courses | - | `https://thinkbeyondeducation.org` | Pricing, footer, Platform |
| Privacy policy | - | `/privacy-policy.html` | footer |

The three one-time products ($249 / $699 / $299-$599) are the ones the first draft
dropped. They are revenue. They live on Pricing (and Credentialing), full stop.

---

## Status accuracy (do not label planned things live)

- Live now: AI Scribe workspace (Prep, Scribe, Review Outside Records, Discern,
  Frameworks, Audit + Coder), Practice Lab, Ask the Archive, Forum, Credentialing Hub.
- In development: full Practice Manager back office.
- Target Fall 2026: ANCC-accredited CE.
- Separate fix (not this restructure): the Terms still call Think Beyond AI "planned"
  while it is live. Reconcile that.

---

## Decisions (resolved 2026-09-27)

1. **Pages/nav:** keep the product pages, ADD Community, keep Insights as a visible
   route. Home behind the logo; Members and Join are account actions.
2. **Forum + Ask the Archive:** their own **Community** page (free vs $50 explained,
   working Archive retained). Home links to it.
3. **`/pricing` and `/about`:** create both. Pricing holds every purchase path; About
   holds the full founder story. Existing homepage anchor links stay working.

## Link / asset verification (2026-09-27)

Checked that destinations resolve from the repo:
- Exist: `index.html`, `insights.html`, `practice-lab-demo.html`,
  `credentialing-concierge-preview.html`, `practice-manager-demo.html`,
  `practice-lab-hub.html`, `privacy-policy.html`, `platform.html`,
  `ai-scribe-workspace.html`.
- Resolve via Netlify redirect: `/practice-lab` -> `practice-lab-hub.html`,
  `/practice-manager-demo` -> `.html`, `/start-scribe` -> join+trial.
- To be created: `/pricing`, `/about`, `/community`.
- NOT testable from this environment (external / backend): the four Stripe buy
  links, the `?buy=` / `?join=` / `?free=` platform checkout paths, and the two
  forms (newsletter capture, Archive email gate). These must be click-tested on the
  built previews before anything replaces the live page.

## Build order (revised per decision: Pricing first)

1. **Pricing / Products** first, it is the highest revenue risk (the draft dropped
   purchase paths), so build and verify it complete before anything links to it.
2. **About** (self-contained; carries founder story, why-different, problem,
   value-stack).
3. **Home** (the router) once Pricing and About are complete to link to.
4. **AI Scribe (Think Beyond AI)** deep-dive.
5. **Community** (forum explainer + working Archive), then align Practice Lab and
   Credentialing to the new nav/footer.
6. Wire site-wide nav, footer, promo bar, email capture, analytics onto every page.

Each page ships as a preview first and carries a checklist back to this map, and its
forms/demos/signup links are click-tested. No page replaces anything live until
Michael verifies it against this document.

# Membership pricing & plan-switching spec

Status: **spec for future work.** The standard $50 Forum / $89 Plus / $149 Full tiers
described here do **not exist yet.** This doc records the pricing model, the switching rules
Michael wants, and the design decisions that must be locked **before** any of it is built.
Nothing in this doc is live except the "Current state" section.

Structure in one line (the canonical ladder — read this before re-deriving it):
**Free (lurk) → $50 Forum (community only) → $89 Plus (everything EXCEPT the AI Scribe) →
$149 Full (everything, incl. the AI Scribe).** The only thing separating Plus from Full is
the AI Scribe. The $50 Forum is a re-open of the original forum-only membership (proven:
~47 members before tools existed). Grandfathered $50 members stay forum-only — no bump.

Billing runs on the **TBP Payments** Stripe account (`acct_1RQbmgIuQAALcBPY`) after the
Circle→TBP migration. Access tiers are driven from Stripe subscription status via
`netlify/functions/stripe-webhook.js` + `_lib/subscription-tier.js` (product → tier map).
See those files before touching any of this.

---

## 1. Current state (live today)

Two membership products on TBP Payments, mapped to access tiers in
`_lib/subscription-tier.js`:

- **Full** — `prod_V6BCxs0i6e64Qt` → tier `full`
- **Forum** — `prod_V6BCJ4Bc25Aw4B` → tier `forum`

Prices in use (lookup_key → id → amount). Grandfathered prices carry
`metadata.tbp_phase = "grandfathered"`; **standard prices have no `tbp_phase`.** That
metadata flag is the machine-readable "is this a legacy rate" marker — rely on it, not on
the dollar amount.

| lookup_key | price id | amount | phase | tier |
|---|---|---|---|---|
| `full_monthly_119` | `price_1U5yqhIuQAALcBPYw94o615V` | $119/mo | **standard** | full |
| `full_annual_1190` | `price_1U5yqoIuQAALcBPYYI2hFBE6` | $1,190/yr | **standard** | full |
| `forum_monthly_50` | `price_1U9Z6iIuQAALcBPYzr8yuKsq` | $50/mo | **standard** | forum |
| `forum_annual_525` | `price_1U9Z90IuQAALcBPYr3jXNnb9` | $525/yr | **standard** | forum |
| `legacy_full_monthly_8900` | `price_1U5yqwIuQAALcBPY1VrhVV6y` | $89/mo | grandfathered | full |
| `full_annual_890_grandfathered` | `price_1U5yr3IuQAALcBPYJ73k52dg` | $890/yr | grandfathered | full |
| `full_annual_1140_grandfathered` | `price_1U5yr9IuQAALcBPYEclwfNuT` | $1,140/yr | grandfathered | full |
| `forum_monthly_50_grandfathered` | `price_1U5yrIIuQAALcBPYqOpa7vQz` | $50/mo | grandfathered | forum |
| `forum_annual_525_grandfathered` | `price_1U5yrOIuQAALcBPYzKl5wQwK` | $525/yr | grandfathered | forum |

> The legacy **$89/mo maps to `full`** ("everything"). This collides in *dollars* with the
> future standard $89 (tools+CE, **no AI**). They are different products/entitlements —
> see Decision B.

Today the system has **two** access levels: `forum` and `full`. New signups buy standard
`full` ($119/mo, $1,190/yr) **or** standard `forum` ($50/mo, $525/yr — reopened Aug 2026;
see §6) via `create-membership-checkout.js` PURCHASABLE (`full_monthly_119`,
`full_annual_1190`, `forum_monthly_50`, `forum_annual_525`). `upgrade-membership.js` still
handles the in-place forum→full upgrade. The $89 Plus / $149 Full standard tiers remain
future work (they need the `plus` tier + `ai_enabled` flag — Decision A).

---

## 2. Target model (future)

Three **standard** tiers. Above them sits the existing **free** tier (read / lurk +
one member-post unlock per month); below "standard" sit the legacy grandfathered rates.

- **$50/mo — "Forum": community only.** No tools, no sims, no CE, no AI Scribe. This is a
  deliberate re-open of the platform's original forum-only membership, which grew to ~47
  paying members before any tools existed — so there is proven standalone demand for a
  low-friction "just read and participate" tier. It exists to catch two segments $89 is too
  steep for: people who only want community, and people who already own an AI scribe and
  won't pay up for ours.
- **$89/mo — "Plus": EVERYTHING except the AI Scribe.** Community + tools + sims + CEs — the
  entire product minus the Scribe. The *only* thing gated out of Plus is the AI Scribe.
- **$149/mo — "Full": everything, incl. the AI Scribe.**

**The whole ladder in one sentence:** Free (lurk) → $50 Forum (community) → $89 Plus
(everything but the Scribe) → $149 Full (+ the Scribe). Full = Plus + one capability (AI).

Members may switch among the **standard** prices only ($50 Forum, $89 Plus, $149 Full);
those are the only prices ever offered as a switch target. (Whether a Plus/Full member can
self-serve *down* to $50 Forum, or only at signup, and the proration on each direction, is
an open implementation choice — see §5.)

Legacy rates stay honored for whoever is on them ($50 forum, $525/yr forum, $119 full,
$890/$1,140 annual full, legacy $89 full), but they are **exit-only** — see the ratchet.

**On the grandfathered $50 cohort:** re-opening a $50 Forum does **not** change what the
existing grandfathered $50 members get. They stay forum-only, same as the new standard $50.
Do **not** hand them extra entitlements (tools/sims) as a "loyalty bump" — it sets a $50
anchor on tooling that undercuts Plus, gives them a reason never to climb, and creates a
$50 dollar-collision for no gain. (Unlike the $89 collision in Decision B, the standard $50
and legacy $50 grant the *same* tier — forum — so they are only distinct prices for
bookkeeping/phase, not for entitlement. Harmless.)

**On the interim $119:** $119 is not a permanent standard — it is the **interim** Full
price offered *while ANCC accreditation is pending*. When accreditation lands and monthly
CEs ship, standard Full becomes **$149 (final)** and the $119 rate converts to
grandfathered (exit-only) like the others. So members never switch *onto* $119; a $119
member can stay put or jump to a standard price and lose $119 forever. The eternal standard
switch targets are **$50 Forum / $89 Plus / $149 Full**. ($149 over $145 is deliberate: it's
the charm price just under the $150 threshold — same buyer perception, ~$4/member/mo more.)

---

## 3. The ratchet: grandfathered rates are a one-way door

**Once a member leaves their grandfathered price — up or down — they lose it permanently
and can only ever land on a standard price.** There is no self-serve path back onto a
legacy rate.

Worked examples Michael gave:

- Grandfathered **$119 full** downgrades to **$89 Plus** (everything but the AI Scribe) →
  they **cannot** return to $119-with-AI. Their only path to AI is standard **$149 Full**.
- **$50 forum** grandfathered → moving to any other tier drops the $50 rate forever.
- Legacy **$89/mo "everything"** → moving off it drops that rate forever.

### How it's enforced (the elegant part)

**Do not write conditional "if they used to be on X" logic.** The ratchet enforces itself
if you obey one rule:

> The only prices ever offered as a **switch target** are the two **standard** prices
> (`$89 Plus`, `$149 Full`). Grandfathered prices are **never** switch targets.

Consequences, for free:
- A legacy member's only moves are: **stay put**, or **jump to a standard price.**
- Once on a standard price, they bounce only between $89 ↔ $149.
- No code path re-selects a legacy price, so **nobody can climb back onto one.**

The `tbp_phase = "grandfathered"` metadata is how the switch endpoint recognizes and
excludes legacy prices; equivalently, keep a hard allowlist of exactly the two standard
lookup_keys and reject everything else.

---

## 4. Two design decisions to lock BEFORE building

### Decision A — access levels — DECIDED: three tiers + an `ai_enabled` capability flag

Today: `forum` / `full`. The target distinguishes **three** standard levels:

1. **Forum** — $50 community only (new standard $50; legacy $50 also lands here)
2. **Plus** — $89 everything **except** the AI Scribe
3. **Full** — $149 everything **incl.** the AI Scribe

**Decision:** because the **only** difference between Plus and Full is the AI Scribe, model
it as a **capability flag**, not a linear rank you have to gate feature-by-feature:

- Add a `plus` tier so the ordering is `free < forum < plus < full` (this cleanly expresses
  Forum-vs-Plus, which *is* a real access-breadth step — Plus unlocks all tools/sims/CE).
- Gate the **AI Scribe alone** on a single `ai_enabled` capability (equivalently `tier ===
  'full'`), and make that flag the **one** source of truth every AI surface reads
  (HPI Generator / Note Builder / Letter Generator AI / `clinical-proxy-stream`). Do **not**
  scatter `tier >= X` checks for AI across the app.

Rationale: Forum→Plus is a genuine breadth jump (community → whole toolkit), so it earns a
tier. Plus→Full is a *single* capability (AI), so it earns a flag, not a second broad rank.
This keeps "can this member use the AI tools" answerable in exactly one place.

Pick one and make it the single source of truth for "can this member use the AI tools."
The AI tools (HPI Generator / Note Builder / Letter Generator AI, clinical-proxy-stream)
must read that one flag.

### Decision B — the $89 collision

Legacy **$89 = Full/everything**; future standard **$89 = Plus/tools+CE, no AI.** Same
dollar amount, opposite entitlement.

- Keep them as **separate products/prices** with **different tier grants** from day one.
- Never let a legacy $89-full member get silently re-mapped to $89-Plus (that would strip
  their AI), and never let a new $89-Plus member get `full`.
- The `tbp_phase` metadata + distinct lookup_keys keep them apart. The legacy one already
  exists as `legacy_full_monthly_8900` → `full`. The new standard $89 must be a **new**
  price (e.g. `plus_monthly_89`) on a **Plus/new** product that grants Plus, not `full`.

---

## 5. Implementation notes (when it's built)

- **Don't use the Stripe Customer Portal plan-switcher.** It only offers a flat list of
  prices and can't express "grandfathered is exit-only" or direction rules. Keep the
  portal's **Subscriptions/switch-plans OFF.** Use the portal only for card updates,
  invoices, customer info, and (optionally) cancel.
- **Do the switch server-side**, extending the existing `upgrade-membership.js` pattern
  into a `switch-membership` endpoint:
  - Allowlist = exactly the standard lookup_keys (`plus_monthly_89`, `full_monthly_149`,
    plus any annual variants). **Reject any grandfathered lookup_key / any price with
    `tbp_phase=grandfathered`.**
  - Resolve target price by lookup_key (same as checkout), update the subscription item,
    set proration sensibly (upgrade → prorate/charge now; downgrade → schedule at period
    end or prorate credit — Michael to choose).
  - Tier follows automatically: the webhook maps the **product** → tier, so pointing the
    sub at the Plus product grants Plus and the Full product grants Full. No manual tier
    writes.
- **Grandfathered members keep their price until they act.** The switch UI shows their
  current plan (possibly a legacy rate) as "current" plus the two standard options as the
  only choices. Choosing a standard option is the irreversible exit.
- **Annuals**: decide whether Plus/Full standard also offer annual, and mirror the same
  ratchet (annual legacy → standard only).
- **Known code gap (fix during the Plus/switching build):** `stripe-webhook.js` currently
  stamps the `subscriptions.is_grandfathered` column from an **amount threshold**
  (`isGrandfathered(amount, interval)` = anything under $119/mo). That mislabels a **new
  standard $50 Forum** member as `is_grandfathered: true`. It is harmless *today* (access +
  tier come from the Forum product → `forum`; the reopened standard $50 and the legacy $50
  grant the identical entitlement, so the legacy/standard distinction is moot for Forum) —
  but before switching launches, change this to read the price's **`tbp_phase` metadata**
  (§3: "rely on `tbp_phase`, not the dollar amount"), since $89 Plus at a below-$119 amount
  would otherwise also be mislabeled. Do it deliberately, with Stripe verification that every
  legacy price actually carries `tbp_phase=grandfathered`, so existing members aren't flipped.

---

## 6. Go-to-market: presentation, sequencing & what to measure

This section is the settled positioning strategy (triangulated across several analyses,
Aug 2026). The tier *structure* is §2; this is how to *sell* it without letting a multi-tier
page optimize the site for "pick the cheapest acceptable plan."

### Presentation — de-emphasize the cheaper tiers, do NOT hide them

The failure mode is a **four-equal-box price table** (Free / $50 / $89 / $149 side by side):
it trains every visitor to comparison-shop down-price, and a "Recommended" ribbon on Full
barely dents it. The opposite mistake is *hiding* the cheaper plans behind an objection
click, which reads as concealment. The answer is **visible but visually subordinate**:

- **Full is the hero.** One product, one price, the primary CTA, plus the founding-rate
  urgency ($119→$149) already live on the site.
- **Plus and Forum sit beneath it, smaller, each tied to a specific objection:**

  ```
  Full — $149/month
  The complete Think Beyond Practice experience. Everything, including AI Scribe.
  [Start Full]

  ── much smaller, below ──
  Already have a scribe you love?   Plus gives you everything else for $89/mo.  [See Plus]
  Primarily here for the community? Join Forum for $50/mo.                      [See Forum]
  ```

A visitor arriving ready to buy Full is never *presented* a cheaper plan to talk themselves
into; a visitor about to bounce because Full doesn't fit finds the right door. Transparent,
not a membership Expedia.

**Subordinate means a smaller button, not a sentence.** "De-emphasized" was first shipped on
the homepage membership card as a one-line text link, and in practice it was invisible: you
had to already know where it was to find it. The $50 tier is meant to *grow* — it feeds the
community that makes everything else worth joining — so it must be impossible to miss even
while it stays clearly secondary. The working hierarchy on the card is:

1. **Full** — filled primary button (`.fork-cta .fork-cta-primary`).
2. **Forum** — outlined secondary button, same width, under a small prompt line
   (`.fork-cta .fork-cta-outline`). A real button, not a link.
3. **Free account** — small teal text link.
4. **"See everything included"** — dim text link.

Visible, not hidden. Secondary, not ashamed.

**Every membership CTA names its tier, its price, and what it includes.** The first cut of
this card paired a vague primary ("Join Think Beyond Practice") with a specific secondary
("Join Forum for $50/mo"), which made the *cheaper* option the only one that told you what
you were buying. Both buttons carry `Join <Tier> — $<price>/mo`, and each is followed by one
small line of substance:

```
[ Join Full — $119/mo ]            ← filled primary
  Everything, including the AI Scribe.

Here mainly for the community?
[ Join Forum — $50/mo ]            ← outlined secondary
  Full community access: post, reply, join case discussions, peer Q&A, and
  member conversations. No tools, CE, or AI Scribe.

Not ready to commit? Start with a free account →
```

Naming the tier ("Join **Full**") also establishes that these are *levels of one membership*
rather than TBP versus some separate forum product. Say "Join Forum", never "Forum only" —
"only" makes it sound lesser before the reader knows what it contains; the subline draws the
boundary. And the subline must state what the tier **does** include before what it doesn't,
so $50 reads as a real product rather than a crippled Full. When Full moves to $149, only
the number in the label changes.

At Plus launch the stack becomes four rungs, still one filled button and the rest subordinate:

```
[ Join Full — $149/mo ]   Everything, including the AI Scribe.
Already have a scribe you love?   [ Plus — $89/mo ]
Here mainly for the community?    [ Forum — $50/mo ]
Just looking around?              Free account →
```

**The same rules apply in-app, not just on the marketing page.** A signed-in `free` member
reaches checkout through several surfaces, and the first pass shipped $50 on only one of them
(the join modal, as a text link). Every upgrade surface aimed at a free member offers both
tiers, each naming tier and price:

- **Platform Home** (`showHome()`, non-paid members only) — a "Become a member" card in the
  scroll path, under the AI Scribe hero. This is the one that makes Forum *discoverable*: the
  account menu is behind an avatar click and the join modal only fires on a content gate, so
  without it a free member can browse for weeks, hit a join button already primed on $119, and
  never learn a $50 door existed. Full filled, Forum outlined beneath, both with sublines.
- **Account menu** (`platform.html`, `updateTopbar()`) — free members get `Join Full — $119/mo`
  *and* `Join Forum — $50/mo`. Forum members keep `Upgrade to Full — $119/mo` (the in-place
  `upgradeMembership()` switch, not a new checkout).
- **Join modal** (`showJoin()`, opened by ~10 content gates) — Full filled, Forum outlined
  beneath with the community-access subline, Forum annual as a small link.

**The one deliberate exception: the founding-rate promo bar stays Full-only.** That bar exists
to make one claim — the $119 rate expires — and putting a cheaper alternative inside a
"lock this in before it rises" message defeats the message. Urgency copy for a specific price
is the one place where offering the other door undercuts the door you are pointing at. Free
members have two other paths to $50, so nothing is hidden by keeping this one single-purpose.

**Each price answers exactly one objection — do not cross-wire them.** "Already have a scribe"
belongs to **Plus**, permanently. It is tempting to point that objection at Forum in the
interim (Plus does not exist yet), but doing so teaches the market a mapping we then have to
*un-teach* at launch — and it is wrong on the merits: someone who already has a scribe and
wants our tools is an $89 Plus customer, not a $50 community customer. **Until Plus ships,
that objection gets no off-ramp at all**; Forum is advertised on community intent only
("Here mainly for the community?"). When Plus launches, the card gains a second outlined
button above Forum's, and only then does "Already have a scribe you love?" appear on the site.

### Route-dependent merchandising — same prices, different hero by entry point

"How aggressively to expose $50/$89" is not one global setting; it's per traffic source.
This is segment-specific *merchandising* of one consistent price list, not inconsistent
pricing:

- **Cold homepage / AI-Scribe campaign** → **Full** leads (off-ramps beneath).
- **"Already have a scribe" campaign** → **Plus** is the hero on that landing page.
- **Community / Facebook clinical-discussion acquisition** → **Forum** can be the first ask.

### Plus → Full upgrade motion — contextual, never a permanent nag

Some Plus members will never upgrade (they genuinely don't need our Scribe) and that is a
*fine* outcome — $1,068/yr beats the $0 we'd get by forcing $149. Do **not** run a persistent
"🚨 you're missing the Scribe" banner. Surface the upgrade at **moments of relevance**, reusing
the in-place `upgrade-membership.js` switch:

- Inside Chart Audit: *"Want the visit drafted before you audit it? AI Scribe is included with Full."*
- From the visit workspace: *"Add AI Scribe to your membership → $149/month."*

Cannibalization does not "self-heal" automatically; a built, well-placed upgrade path is what
recaptures softened Full revenue over time.

### Value-ladder story (use in copy)

The spacing tells a clean value story — lead with it rather than a feature matrix:

```
Community              $50
+ the practice platform   +$39  (tools, sims, CE — essentially everything)
+ integrated AI docs      +$60  (the AI Scribe)   → Full $149
```

That implicitly prices the Scribe at ~$60/mo for an existing Plus member — competitive with
standalone scribes, and ours is integrated with the rest of the platform, not isolated.

### Sequencing (confirmed)

- **Now:** reopen **$50 Forum**. This is not an experiment — the forum-only product already
  reached ~47 paying members before any tools existed. It needs no CE, no `ai_enabled` flag,
  no $149 transition; it rides the existing Forum product → `forum` tier + the checkout
  allowlist. Lowest-risk piece.
- **At ANCC accreditation:** launch **$89 Plus** and move public **Full $119 → $149**, while
  the existing $119 members stay grandfathered at $119. Waiting means Plus launches with a
  *complete* value prop (CE is real), not "everything except Scribe, plus CE eventually." One
  clean "**Three ways to join** — Community $50 / Plus $89 / Full $149" announcement, where
  $149 sits at the top of an understandable ladder instead of looking like a jump from $50.

### What to measure once Plus launches (this ends the cannibalization debate)

Track, and read at 90–180 days:
- new Full conversion
- new Plus conversion
- **Full → Plus downgrades** (the real risk isn't new buyers picking $89 — it's *existing*
  Full members who already use another scribe asking "why am I paying $149?")
- Plus → Full upgrades
- Forum → Plus/Full upgrades
- churn by tier

If Plus expands the market it shows here; if it mostly cannibalizes Full it shows here too.
Data decides, not philosophy.

### Legacy $50 messaging at launch

New standard $50 Forum grants the *same* thing existing grandfathered $50 members already
have, so do **not** dress grandfathering up as a loyalty perk ("you keep your rate" is empty
when new members pay the same $50). Just reassure, plainly: *"If you're already a Forum
member, nothing changes. Your membership continues exactly as it does today."*

### Strategic optionality (note, do not build around it)

Separating *platform value* from *one AI capability* (the `ai_enabled` flag) keeps later
cross-specialty configurations and partner/licensing arrangements flexible — a collaborator
could access specific infrastructure without consuming the full psych community/CE layer.
Not a current build; the structure simply doesn't box us in. See `FUTURE-OPPORTUNITIES.md`.

---

## 7. Related files

- `netlify/functions/_lib/subscription-tier.js` — product→tier map, `TIER_RANK`,
  `isGrandfathered`. Decision A changes this.
- `netlify/functions/stripe-webhook.js` — applies tier on subscription events (fallback
  tier is `forum`; unknown products must be mapped or they downgrade).
- `netlify/functions/create-membership-checkout.js` — new-member purchase allowlist.
- `netlify/functions/upgrade-membership.js` — the existing controlled switch; generalize
  this for downgrades + the standard-only allowlist.
- `netlify/functions/admin-legacy-link.js` — admin-only reinstatement at a legacy rate
  (points at the TBP products). This is the **only** sanctioned way to put someone back on
  a legacy price, and it's manual/secret-gated — consistent with "no self-serve return."

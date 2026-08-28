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
| `legacy_full_monthly_8900` | `price_1U5yqwIuQAALcBPY1VrhVV6y` | $89/mo | grandfathered | full |
| `full_annual_890_grandfathered` | `price_1U5yr3IuQAALcBPYJ73k52dg` | $890/yr | grandfathered | full |
| `full_annual_1140_grandfathered` | `price_1U5yr9IuQAALcBPYEclwfNuT` | $1,140/yr | grandfathered | full |
| `forum_monthly_50_grandfathered` | `price_1U5yrIIuQAALcBPYqOpa7vQz` | $50/mo | grandfathered | forum |
| `forum_annual_525_grandfathered` | `price_1U5yrOIuQAALcBPYzKl5wQwK` | $525/yr | grandfathered | forum |

> The legacy **$89/mo maps to `full`** ("everything"). This collides in *dollars* with the
> future standard $89 (tools+CE, **no AI**). They are different products/entitlements —
> see Decision B.

Today the system has **two** access levels: `forum` and `full`. New signups/upgrades buy
standard `full` only (`create-membership-checkout.js` PURCHASABLE = `full_monthly_119`,
`full_annual_1190`; `upgrade-membership.js` mirrors it).

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

---

## 6. Related files

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

# Membership pricing & plan-switching spec

Status: **spec for future work.** The standard $89 / $149 tiers described here do **not
exist yet.** This doc records the pricing model, the switching rules Michael wants, and
the two design decisions that must be locked **before** any of it is built. Nothing in
this doc is live except the "Current state" section.

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

Two **standard** tiers:

- **$89/mo — "Plus": forum + tools + CE, no AI**
- **$149/mo — "Full": everything, incl. AI**

Members may switch **only between $89 and $149.** Those are the only two prices ever
offered as a switch target.

Legacy rates stay honored for whoever is on them ($50 forum, $525/yr forum, $119 full,
$890/$1,140 annual full, legacy $89 full), but they are **exit-only** — see the ratchet.

**On the interim $119:** $119 is not a permanent standard — it is the **interim** Full
price offered *while ANCC accreditation is pending*. When accreditation lands and monthly
CEs ship, standard Full becomes **$149 (final)** and the $119 rate converts to
grandfathered (exit-only) like the others. So members never switch *onto* $119; a $119
member can stay put or jump to a standard price and lose $119 forever. The two eternal
standard switch targets are **$89 Plus ↔ $149 Full**. ($149 over $145 is deliberate: it's
the charm price just under the $150 threshold — same buyer perception, ~$4/member/mo more.)

---

## 3. The ratchet: grandfathered rates are a one-way door

**Once a member leaves their grandfathered price — up or down — they lose it permanently
and can only ever land on a standard price.** There is no self-serve path back onto a
legacy rate.

Worked examples Michael gave:

- Grandfathered **$119 full** downgrades to **$89 Plus** (tools+CE, no AI) → they **cannot**
  return to $119-with-AI. Their only path to AI is standard **$149 Full**.
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

### Decision A — access levels: 2 → 3 (or add an AI capability flag)

Today: `forum` / `full`. The target needs to distinguish **three** things:

1. `forum` — legacy $50 (community only)
2. **Plus** — $89 tools + CE, **no AI**
3. **Full** — $149 everything, **incl. AI**

Two viable shapes:
- **Third tier**: add e.g. `plus` between `forum` and `full` in `TIER_RANK` and
  `PRODUCT_TIER`, and gate AI on tier ≥ `full`. Simple ordering, but every tier check in
  the app must learn the new rank.
- **Capability flag**: keep `forum`/`full` and add a separate `ai_enabled` boolean (or an
  entitlements set) that $149 grants and $89 doesn't. Cleaner if "AI" is the only thing
  that separates Plus from Full and more tiers/features are coming.

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

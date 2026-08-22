# TBP Member Marketplace — Design of Record (Denis mentorship pilot)

Status: **build in progress.** Branch `claude/think-beyond-member-sales-girogz`. Nothing live until pushed to `main` + the Supabase migration is applied with Michael's sign-off.

## What this is (and is NOT)

TBP's business is **membership**, not transaction commission. This feature lets **members sell**
(mentorship first; courses/templates/workshops later); **anyone can buy**; every purchase runs
**through TBP**; and every **nonmember buyer is offered a free month of TBP** that auto-converts —
so sellers marketing their own offering also funnel members into TBP. The Denis pilot is the first
small instance of that flywheel. Do NOT reduce this to "a booking calendar for Denis."

Only eligible **members** can sell (Denis qualifies via his lifetime forum access). Selling is a
membership privilege, gated by admin approval (quality bar: "if it's offered through TBP, it's worth
looking at").

## Locked decisions (do not silently change — these are agreed economics)

| Decision | Value |
|---|---|
| Pilot seller | Denis Grigorov (2–4 sessions/mo initially) |
| Session length | 60 min |
| Session price | **$200 nonmember / $180 member** |
| Toolkit | existing `template_library` row `723c2236-4d83-452c-972f-952b4810abbe`, **$699 / $399 member** |
| Practice Launch bundle | session + toolkit → **$899 nonmember / $599 member** |
| Toolkit split (bundle) | **50/50** Denis / TBP |
| Charge model | **Direct charge on Denis's connected account** (mirrors the letter flow). Bundle adds `application_fee_amount` = TBP's toolkit half. Denis is merchant of record; TBP only ever collects a fee → **no 1099 either direction** |
| Free month | **Nonmembers only**, delivered as a **separate platform Checkout** (subscription mode, $0 now + 30-day trial → auto-converts to $119 via `full_monthly_119`). **No skip / no comp fallback** — complete it or no month |
| Member pricing | resolved **server-side from a live `accounts` DB read** (never the 30-day token claim); a **promo-trial `full` does NOT count as a paid member** for member pricing (spec §9) |
| Onboarding | reuse the existing Connect OAuth flow (`letter-connect-*`); seller's `acct_` lives on `accounts.stripe_connect_account_id[_test]` |
| Mode | reuse the letter fail-safe: test unless `LETTER_PAY_MODE=live` (or a marketplace-specific `MARKETPLACE_PAY_MODE`, TBD) |

## Purchase flows

**Standalone session (nonmember):**
1. Buyer picks a slot + enters topic → server prices from live tier ($200) → **direct-charge Checkout on Denis's account** (no app fee — TBP takes nothing on his time). Slot held.
2. Connect webhook `checkout.session.completed` (connected account) → mark order paid, confirm booking, email buyer + Denis.
3. Success page → **Step 2**: platform subscription Checkout ($0 + 30-day trial). Buyer must complete to get the month.
4. Platform webhook `customer.subscription.*` → existing tier sync sets `full` (trialing); record trial-grant attribution.

**Standalone session (member):** $180 direct charge, no app fee, no Step 2. Booking confirmed.

**Bundle (nonmember $899 / member $599):** direct charge on Denis's account with
`application_fee_amount` = toolkit half ($349.50 / $199.50). Connect webhook → mark paid, **grant
toolkit access** (entitlement row + reuse `template-download.js` gate), confirm booking. Nonmember →
Step 2 trial. Member → no Step 2.

Slot holds released on expired/canceled Checkout. Webhooks are the source of truth (never grant on
success-URL alone). All fulfillment idempotent (match on our order/booking id; flip only pending rows).

## Additive schema (all new `marketplace_*` tables; nothing existing altered)

- `marketplace_sellers` — id, account_id→accounts, display_name, bio, expertise, avatar_url,
  timezone, meeting_instructions, status(draft|pending|active|paused|rejected|archived),
  approved_at, timestamps. (Connect `acct_` reused from `accounts.stripe_connect_account_id[_test]`.)
- `marketplace_offerings` — id, seller_id, type('service'), title, description, duration_minutes,
  price_public_cents, price_member_cents, bundle_enabled, bundle_toolkit_template_id→template_library,
  bundle_price_public_cents, bundle_price_member_cents, toolkit_seller_split_pct(50),
  grants_trial(bool), trial_days(30), status(draft|active|paused), timestamps.
- `marketplace_availability` — id, seller_id, starts_at(UTC), ends_at(UTC),
  status(open|held|booked), hold_expires_at, timestamps.
- `marketplace_orders` — id, buyer_account_id(nullable), buyer_email, seller_id, offering_id,
  kind(session|bundle), pricing_context(public|member), amount_total_cents, currency,
  stripe_connected_account, stripe_checkout_session_id, stripe_payment_intent,
  application_fee_cents, status(pending|paid|canceled|refunded), test_mode, timestamps, paid_at.
- `marketplace_order_items` — id, order_id, item_type(session|toolkit), description, amount_cents,
  quantity, template_id(nullable). (Immutable price snapshot; integer cents.)
- `marketplace_revenue_allocations` — id, order_id, order_item_id(nullable),
  recipient(seller|tbp), amount_cents, allocation_type(direct_net|application_fee), note.
- `marketplace_bookings` — id, order_id, seller_id, availability_id, buyer_account_id(nullable),
  buyer_email, starts_at, ends_at, buyer_timezone, topic, kind, toolkit_included, meeting_url,
  status(held|pending_payment|confirmed|completed|cancelled_by_buyer|cancelled_by_seller|no_show|refunded),
  timestamps, cancelled_at.
- `marketplace_trial_grants` — id, account_id(nullable), buyer_email, source_order_id,
  source_seller_id, stripe_subscription_id, granted_at, expires_at, converted_at,
  status(trialing|converted|expired|canceled). One promo month per user lifetime (enforced server-side).
- `marketplace_attribution` — id, seller_id, visitor_id, utm_source, utm_medium, utm_campaign,
  referrer_url, landing_at, buyer_email(nullable), order_id(nullable), became_member(bool), timestamps.

Toolkit entitlement reuses the existing `template_purchases` + `template-download.js` gate (fix the
gate ordering so an owner who is `templates_blocked` can still download what they bought).

## Env / secrets (reuse the letter Connect set)

`STRIPE_SECRET_KEY` (live platform), `STRIPE_CONNECT_TEST_SECRET_KEY`, `STRIPE_CONNECT_CLIENT_ID(_TEST)`,
`STRIPE_CONNECT_WEBHOOK_SECRET`, `LETTER_PAY_MODE`/`MARKETPLACE_PAY_MODE`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `SESSION_SIGNING_SECRET`, `SES_*`, `PUBLIC_BASE_URL`.

## Build order (dependency-ordered)

1. Supabase migration (additive tables) — **sign-off before applying**.
2. Seller foundation + admin approval (reuse `admin-dashboard.js` auth via `accounts.is_admin`).
3. Seller Connect onboarding — reuse `letter-connect-*` (Denis connects once).
4. Availability + booking (slot hold, UTC storage, transactional double-booking guard).
5. Checkout Step 1 — direct charge on Denis's account (+ app fee for bundle); server-side member pricing.
6. Connect webhook fulfillment — mark paid, confirm booking, grant toolkit, revenue allocations.
7. Checkout Step 2 — platform subscription-with-trial ($0 → $119); trial-grant + attribution.
8. Toolkit entitlement + download-gate fix.
9. Notifications (SES via `_lib/notify.js`): buyer confirmation + ICS, Denis notification, reminders.
10. Denis's public offering page (`/mentors/denis-grigorov`) — server-side member pricing, prominent free-month.
11. Seller dashboard (slots + bookings + basic sales) and admin marketplace views + funnel analytics.

## Deferred — DO NOT FORGET (committed follow-up)

**Option 2 — one card entry.** Today (Option 1) the buyer enters their card twice: once for Denis's
direct charge, once to activate the free-month trial on the platform. The polished version collects the
card **once on the platform**, starts the $0 trial, and **clones the payment method to Denis's connected
account** (platform→connected cloning is allowed) to run his direct charge. Not built in the pilot
because it's a custom cross-account payment flow (PM cloning + possible second 3DS auth + rollback
sequencing) — disproportionate risk for 2–4 sessions/mo. **Revisit once the funnel is proven to convert.**

## Not for the pilot (per spec §33)

Multi-seller cart, course authoring, open seller registration, ratings/reviews, Google/Outlook calendar
sync, custom video, seller coupons, marketplace search/filtering. Architecture stays generic so seller #2
needs no rewrite, but only Denis's path is built now.

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

## Who can sell — archetypes, seating, and the money principle

The "only members sell" rule above was written for **Denis** (a member-mentor) and is correct
for peer clinical depth. It is **too narrow** for operational vendors. Generalize it as
follows — this changes **no** locked Denis economics, it only widens *who* can sell beyond him.

### The money principle (what TBP takes, and what it does not)

**Earn only on value TBP actually contributes — its IP, its platform/audience, its curation.
Take nothing on the expert's raw time.** This is not "take no cut"; it is usually *more
generous*. In the Denis pilot, concretely:
- **0%** of Denis's session fee ($200/$180) — his labor, his money, no application fee.
- **50%** of the toolkit in the bundle — but the toolkit is *TBP's own product*, and TBP is
  *giving away the other half* of revenue it would otherwise keep 100%. The expert makes
  money *from* TBP (its IP, platform, setup), not the other way round.

So the money flow is the **opposite** of a predatory platform: TBP funds experts off its own
product; it does not tax members or tax the experts' time. That is the concrete answer to the
"is this predatory?" worry — the platform pays the experts, it does not rent-seek them.

### Three lanes

1. **Member-experts (peer/clinical depth — the Denis lane).** Must be members. Here the
   membership requirement is a *feature*: it keeps clinical mentorship as community peers
   helping peers (not outside vultures) and makes selling a membership privilege.
2. **Vetted operational vendors (credentialing, EHR setup, billing, VAs).** External pros,
   often not clinicians. Do **not** force a clinical membership. Vet by track record +
   references + a **fair, transparent rate** (vetting the *rate* is the anti-grift move). TBP
   earns only on bundled TBP IP (e.g. the Credentialing Hub), nothing on their hours.
3. **Partners / collaborators (cross-specialty, e.g. Mallory).** Not marketplace sellers —
   separate bilateral deals (cross-promo, rev-share, content). The members-only rule does not
   apply to them.

### Seating: comp a Forum membership

Every seller is seated as a **member**, but experts/vendors get a **comped $50 Forum
membership** (community tier) rather than being made to pay. This makes "only members sell"
true in spirit and in the database, gives them forum presence to contribute and build trust
(the flywheel), and — since the standard $50 Forum tier is now live (Aug 2026) — is a real,
available seat. Comp **Forum, not Full**: they need community presence, not the clinical
toolkit.

**Governance:** a comped seller seat must **not** count as a paying member. Mark it with
`internal_label` (the same flag that keeps internal accounts out of the activation nudges) so
it grants forum access but stays out of paying-member counts and MRR — the same rule already
applied to promo-trials (§9: a promo-trial `full` does not count as paid).

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

## Phase 2 (spec only, NOT built) — AI Session Snapshot for 1:1s

An **opt-in** ambient assistant for mentorship calls that produces a **Session Snapshot** (a written
recap plus action items) the mentor keeps and can share with the mentee, with optional follow-up
reminders. On-thesis with the CLINICAL-OS "capture context once, reuse it intentionally" principle,
but applied to a coaching call, not a clinical encounter. **Do not build until the booking/payment
pilot is actually transacting** (Denis connected, `MARKETPLACE_PAY_MODE=live`, real sessions
happening). Bolting AI on before a single real booking is premature.

**Hard constraints (these are requirements, not niceties):**

1. **NOT a clinical/PHI encounter.** These are provider-to-provider coaching calls. Do **not** route
   audio/transcript through the BAA `clinical-proxy-stream.mjs` pipe (that pipe is for patient PHI).
   Use a separate, access-controlled path. A mentee may still reference a de-identified case or their
   own practice details, so treat transcripts as sensitive and scope access to the two parties.
2. **Two-party consent, logged.** Recording/transcribing triggers two-party-consent law in many
   states. Require explicit, timestamped consent from **both** mentor and mentee before anything
   listens. Store consent (who, when) with the session. No consent → no capture, no exceptions.
3. **Mentorship-specific template, NOT the clinical one.** The Scribe's HPI/assessment structure is
   wrong here. Snapshot fields: topics discussed, advice/decisions given, action items (owner + due),
   resources recommended, and next-step/follow-up date. Keep it simple and coaching-shaped.
4. **Device-mic first; no Zoom bot in phase 2.** The 1:1s run over Zoom. Phase 2 = the mentor runs
   the existing browser-mic Scribe on their own device during the call (reuses current capture +
   transcription). A bot that joins the Zoom (Recall.ai-style) is a much larger integration and is
   explicitly out of phase 2.

**Sketch (when built):**
- `marketplace_bookings.snapshot_opt_in` (bool, mentor toggle) + a consent record per session.
- New `marketplace_session_snapshots` table: `booking_id`, `transcript_ref` (access-controlled
  storage, not the BAA bucket), `summary_json` (the fields in constraint 3), `shared_with_mentee_at`,
  `created_at`. Additive only.
- Model calls reuse the existing non-clinical proxy + a new mentorship-summary prompt. Log cost per
  session; transcripts and snapshots are storage + a maintenance surface, so weigh both.
- Delivery + follow-up reminders ride the existing SES/notification layer
  (`marketplace-notify.js`): email the mentee the snapshot on share; schedule the follow-up nudge.
- **Retention angle:** the snapshot is a tangible artifact the mentee keeps, which reinforces the
  free-month → stay conversion. That is the product reason to build it, once the funnel is proven.

## Phase 2 (spec only, NOT built) — Video + calendar automation

**What already works (pilot):** booking confirmations carry a real `.ics` invite to **both**
parties (`marketplace-notify.js`), with the meeting link in the event `LOCATION`. The meeting link
is the mentor's **static room link** from the dashboard `meeting_instructions` field (reused for
every booking). This is the recommended v1: zero integration, works end to end. Its limits: emailed
`.ics` is not a live two-way sync (a later reschedule inside Google/Outlook does not propagate), and
one static room means no per-session isolation.

**Per-booking Zoom (first automation to add).** Mint a unique Zoom meeting per booking instead of a
static room. Sketch:
- Zoom **OAuth per mentor** (each seller connects their own Zoom, mirroring the Stripe Connect
  pattern): store `accounts.zoom_refresh_token` (additive), refresh on demand.
- On booking fulfillment (`marketplace-fulfill.js`), if the seller has Zoom connected, call
  `POST /users/me/meetings` to create the session and write the join URL to
  `marketplace_bookings.meeting_url` (column already exists). The existing notify path already emails
  `meeting_url` and puts it in the ICS, so no notification changes needed.
- Fallback stays the static `meeting_instructions` link when Zoom is not connected. Never block a
  booking on Zoom failure: on API error, fall back to the static link and log.
- Out of scope even here: auto-reschedule/cancel syncing the Zoom meeting when a slot moves.

**True calendar sync (later, if ever).** Google/Outlook Calendar API with OAuth per mentor for
two-way sync + free/busy. On the "not for the pilot" list; Google Calendar `conferenceData` would
also mint a Meet link, folding video + sync into one integration if we go Google-first. Large build;
revisit only if mentors ask for real calendar sync.

## Phase 2 (spec only, NOT built) — Expert question routing

Problem: comped experts/vendors will not camp in the forum. Pull them in on demand. When a
member posts a question matching an expert's declared topics, notify that expert (email/text)
with the question + a one-click link to answer — so they show up when they're actually needed,
not constantly.

- **Manual version first (no build).** When a good question lands, an admin taps the relevant
  expert by hand (@mention / DM / email: "can you take this one?"). This learns which topics
  recur and — critically — which experts actually respond when pinged (the same reliability
  vet used everywhere else). Automate only once experts reliably answer and volume justifies
  it. Do things that don't scale first.
- **Guardrail — this is the Lisa line: the alert prompts ANSWERING, not selling.** Set the
  norm with experts explicitly: you're tapped to help in the free forum, not to funnel the
  asker into a paid 1:1. If experts use alerts as a sales trigger, the free forum becomes bait
  and the free-lane-stays-sufficient guardrail breaks. Answer first; paid depth stays
  available but unpushed.
- **When automated, reuse what exists:** `marketplace_sellers.expertise` (topic tags already
  in the schema), the SES notify layer (`_lib/notify.js`), post `?post=<id>` deep-links +
  one-click sign-in. Throttle to avoid alert fatigue: digest or per-expert cap, relevant
  spaces only, and prefer "still unanswered after N hours" over "every post" so it reads as
  *questions that need you*, not noise. Additive only; nothing existing changes.

## Go-live checklist (what Michael configures)

Everything defaults to **test mode** and moves no real money until `MARKETPLACE_PAY_MODE`
(or `LETTER_PAY_MODE`) is `live`.

1. **Stripe Connect webhook — nothing new required.** Marketplace direct charges land on
   the **existing letter Connect webhook** (`letter-charge-webhook.js`), which now delegates
   them to the shared fulfillment. So the Connect webhook you already registered covers the
   marketplace too — no new endpoint, no new secret. (Optional: if you'd rather run a
   dedicated endpoint, `marketplace-charge-webhook.js` still exists; register it as a Connect
   webhook on `checkout.session.completed` with secret
   `STRIPE_MARKETPLACE_CONNECT_WEBHOOK_SECRET`.)
2. **Platform webhook — already done.** The free-month trial (Step 2) rides the existing
   platform webhook (`stripe-webhook.js`, `STRIPE_WEBHOOK_SECRET`); it already receives
   `checkout.session.completed` + `customer.subscription.*`. No new platform webhook.
3. **Env vars** (all reused from the letter Connect work): `STRIPE_SECRET_KEY`,
   `STRIPE_CONNECT_TEST_SECRET_KEY`, `STRIPE_CONNECT_CLIENT_ID(_TEST)`,
   `STRIPE_CONNECT_WEBHOOK_SECRET`, plus the new
   `STRIPE_MARKETPLACE_CONNECT_WEBHOOK_SECRET`. Optional `MARKETPLACE_PAY_MODE`.
4. **Denis onboards:** sign in → `/mentor-dashboard.html` → **Connect with Stripe**
   (reuses the letter OAuth flow; writes `accounts.stripe_connect_account_id[_test]`).
   He then adds availability slots there.
5. **Denis's public link:** `https://thinkbeyondpractice.com/mentors/denis-grigorov`.
6. **Test-mode caveat:** the direct-charge → booking → toolkit path is fully testable in
   sandbox. The Step-2 trial needs the `full_monthly_119` price to exist on whichever
   platform account the mode points at; verify it resolves (it exists on live TBP Payments).

## Not for the pilot (per spec §33)

Multi-seller cart, course authoring, open seller registration, ratings/reviews, Google/Outlook calendar
sync, custom video, seller coupons, marketplace search/filtering. Architecture stays generic so seller #2
needs no rewrite, but only Denis's path is built now.

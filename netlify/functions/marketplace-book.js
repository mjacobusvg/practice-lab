// netlify/functions/marketplace-book.js
//
// STEP 1 of the buyer flow: hold a slot and create the payment.
// The payment is a DIRECT CHARGE on the SELLER's connected Stripe account
// (platform key + { stripeAccount } header). For a bundle we add
// application_fee_amount = TBP's toolkit half, so the seller is merchant of record,
// keeps their money, and TBP only collects a fee (no payout to the seller).
//
// Member vs public pricing is resolved SERVER-SIDE from a live accounts read
// (never the token's tier claim, which can be 30 days stale). A promo-trial-only
// "member" is priced as public (see _lib/marketplace.resolveBuyer).
//
// The free-month trial is NOT here — a nonmember buyer is sent to
// marketplace-activate-trial.js from the success page (Step 2).
//
// Body: { seller_id|slug, offering_id, slot_id, kind:'session'|'bundle',
//         buyer_email, buyer_timezone?, topic?, token?, success_url, cancel_url }
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_*_KEY, MARKETPLACE/LETTER_PAY_MODE,
//      SESSION_SIGNING_SECRET, PUBLIC_BASE_URL

const { verifyToken } = require('./_lib/session');
const {
  sb, isLive, connectAcctColumn, platformStripe, resolveBuyer, priceOffering
} = require('./_lib/marketplace');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};
const j = (s, o) => ({ statusCode: s, headers: CORS, body: JSON.stringify(o) });
const HOLD_MINUTES = 30;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return j(200, {});
  if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return j(400, { error: 'Bad JSON' }); }
  const kind = body.kind === 'bundle' ? 'bundle' : 'session';
  const slotId = String(body.slot_id || '').trim();
  const offeringId = String(body.offering_id || '').trim();
  if (!slotId || !offeringId) return j(400, { error: 'offering_id and slot_id required' });
  if (!body.success_url || !body.cancel_url) return j(400, { error: 'success_url and cancel_url required' });

  // Buyer identity: prefer the signed token's email; fall back to the typed email.
  let email = '';
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  if (token) {
    const s = verifyToken(token);
    if (s.valid && s.claims && s.claims.email) email = String(s.claims.email).toLowerCase().trim();
  }
  if (!email) email = String(body.buyer_email || '').toLowerCase().trim();
  if (!email || email.indexOf('@') === -1) return j(400, { error: 'A valid email is required.' });

  try {
    // ---- Load offering + seller ----
    const offerings = await sb('marketplace_offerings?id=eq.' + encodeURIComponent(offeringId) +
      '&status=eq.active&select=*&limit=1');
    const offering = offerings && offerings[0];
    if (!offering) return j(404, { error: 'Offering not available' });
    if (kind === 'bundle' && !offering.bundle_enabled) return j(400, { error: 'Bundle not available' });

    const sellers = await sb('marketplace_sellers?id=eq.' + offering.seller_id +
      '&status=eq.active&select=id,account_id,display_name,meeting_instructions&limit=1');
    const seller = sellers && sellers[0];
    if (!seller) return j(404, { error: 'Seller not available' });

    // ---- Resolve the seller's connected account (mode-split) ----
    const acctCol = connectAcctColumn();
    const sacc = await sb('accounts?id=eq.' + seller.account_id + '&select=' + acctCol + '&limit=1');
    const connectedAccount = sacc && sacc[0] && sacc[0][acctCol];
    if (!connectedAccount) return j(409, { error: 'seller_not_ready', message: 'This mentor has not finished connecting payments yet.' });

    // ---- Price it (server-side member check) ----
    const buyer = await resolveBuyer(email);
    const priced = priceOffering(offering, kind, buyer.isMember);

    // ---- Atomically HOLD the slot (open, or a held slot whose hold expired) ----
    const holdUntil = new Date(Date.now() + HOLD_MINUTES * 60 * 1000).toISOString();
    const nowIso = new Date().toISOString();
    const held = await sb(
      'marketplace_availability?id=eq.' + encodeURIComponent(slotId) +
      '&seller_id=eq.' + seller.id +
      '&or=(status.eq.open,and(status.eq.held,hold_expires_at.lt.' + nowIso + '))',
      'PATCH',
      { status: 'held', hold_expires_at: holdUntil },
      'return=representation'
    );
    if (!held || !held.length) return j(409, { error: 'slot_taken', message: 'That time was just taken — please pick another.' });
    const slot = held[0];

    // ---- Create the order + items + allocations (pending) ----
    const orderRows = await sb('marketplace_orders', 'POST', {
      buyer_account_id: buyer.account ? buyer.account.id : null,
      buyer_email: email,
      seller_id: seller.id,
      offering_id: offering.id,
      kind: kind,
      pricing_context: priced.pricingContext,
      amount_total_cents: priced.amountTotalCents,
      currency: 'usd',
      stripe_connected_account: connectedAccount,
      application_fee_cents: priced.applicationFeeCents,
      status: 'pending',
      test_mode: !isLive()
    }, 'return=representation');
    const order = orderRows[0];

    await sb('marketplace_order_items', 'POST',
      priced.items.map(function (it) { return Object.assign({ order_id: order.id }, it); }),
      'return=minimal');
    await sb('marketplace_revenue_allocations', 'POST',
      priced.allocations.map(function (a) { return Object.assign({ order_id: order.id }, a); }),
      'return=minimal');

    // Best-effort: stamp this order onto the visitor's attribution row (first-touch).
    const visitorId = body.visitor_id ? String(body.visitor_id).slice(0, 80) : '';
    if (visitorId) {
      await sb('marketplace_attribution?seller_id=eq.' + seller.id +
        '&visitor_id=eq.' + encodeURIComponent(visitorId) + '&order_id=is.null',
        'PATCH', { buyer_email: email, order_id: order.id }, 'return=minimal').catch(function () {});
    }

    // ---- Booking row (pending_payment) ----
    const bookingRows = await sb('marketplace_bookings', 'POST', {
      order_id: order.id,
      seller_id: seller.id,
      availability_id: slot.id,
      buyer_account_id: buyer.account ? buyer.account.id : null,
      buyer_email: email,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      buyer_timezone: body.buyer_timezone ? String(body.buyer_timezone).slice(0, 64) : null,
      topic: body.topic ? String(body.topic).slice(0, 2000) : null,
      kind: kind,
      toolkit_included: kind === 'bundle',
      status: 'pending_payment'
    }, 'return=representation');
    const booking = bookingRows[0];

    // ---- Create the Checkout Session on the SELLER's connected account ----
    const stripe = platformStripe();
    const lineItems = priced.items.map(function (it) {
      return {
        quantity: it.quantity || 1,
        price_data: { currency: 'usd', unit_amount: it.amount_cents, product_data: { name: it.description } }
      };
    });
    const piData = {
      description: (offering.title + (kind === 'bundle' ? ' + Private Practice Toolkit' : '')).slice(0, 200),
      metadata: { tbp: 'marketplace', order_id: order.id, booking_id: booking.id, kind: kind }
    };
    if (priced.applicationFeeCents > 0) piData.application_fee_amount = priced.applicationFeeCents;

    // Success goes back to the buyer page with the order id so Step 2 (free month)
    // can fire for nonmembers. Include a marker the page reads.
    const sep = body.success_url.indexOf('?') === -1 ? '?' : '&';
    const successUrl = body.success_url + sep + 'mp_order=' + encodeURIComponent(order.id);

    let checkout;
    try {
      checkout = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: email,
        line_items: lineItems,
        payment_intent_data: piData,
        metadata: { tbp: 'marketplace', order_id: order.id, booking_id: booking.id, kind: kind },
        success_url: successUrl,
        cancel_url: body.cancel_url
      }, { stripeAccount: connectedAccount });
    } catch (e) {
      // Roll back: release the slot, cancel the order + booking.
      await sb('marketplace_availability?id=eq.' + slot.id, 'PATCH', { status: 'open', hold_expires_at: null }, 'return=minimal').catch(function () {});
      await sb('marketplace_orders?id=eq.' + order.id, 'PATCH', { status: 'canceled' }, 'return=minimal').catch(function () {});
      await sb('marketplace_bookings?id=eq.' + booking.id, 'PATCH', { status: 'cancelled_by_buyer' }, 'return=minimal').catch(function () {});
      return j(502, { error: 'Payment could not be started: ' + e.message });
    }

    await sb('marketplace_orders?id=eq.' + order.id, 'PATCH', { stripe_checkout_session_id: checkout.id }, 'return=minimal').catch(function () {});

    return j(200, {
      ok: true,
      url: checkout.url,
      order_id: order.id,
      is_member: buyer.isMember,
      needs_trial: !buyer.isMember,   // nonmember -> success page runs Step 2
      amount_total_cents: priced.amountTotalCents,
      test_mode: !isLive()
    });
  } catch (e) {
    return j(500, { error: e.message });
  }
};

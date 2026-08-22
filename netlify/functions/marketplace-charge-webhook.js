// netlify/functions/marketplace-charge-webhook.js
//
// CONNECT webhook: checkout.session.completed for marketplace direct charges
// created on sellers' connected accounts (marketplace-book.js). On payment:
//   1. Verify the Stripe signature (Connect webhook signing secret).
//   2. Mark the order PAID (idempotent) and confirm the booking + book the slot.
//   3. For a bundle, grant toolkit access (ensure a buyer account exists, then
//      insert a template_purchases row — reuses the existing entitlement gate).
//
// Register this in Stripe as a CONNECT webhook (events on connected accounts),
// same signing secret family as the letter charge webhook.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_CONNECT_WEBHOOK_SECRET,
//      STRIPE_CONNECT_TEST_SECRET_KEY / STRIPE_SECRET_KEY (SDK only)

const { sb, ensureAccount } = require('./_lib/marketplace');
const { sendBuyerConfirmation, sendSellerNotification } = require('./_lib/marketplace-notify');

const H = { 'Content-Type': 'application/json' };

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: JSON.stringify({ error: 'Method not allowed' }) };

  const stripe = require('stripe')(process.env.STRIPE_CONNECT_TEST_SECRET_KEY || process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Webhook not configured' }) };

  let ev;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    ev = stripe.webhooks.constructEvent(raw, event.headers['stripe-signature'], secret);
  } catch (err) {
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Signature verification failed: ' + err.message }) };
  }

  if (ev.type !== 'checkout.session.completed') {
    return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, ignored: ev.type }) };
  }
  const s = ev.data.object;
  if (!(s.metadata && s.metadata.tbp === 'marketplace' && s.metadata.order_id)) {
    return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, not_marketplace: true }) };
  }
  if (s.payment_status && s.payment_status !== 'paid') {
    return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, payment_status: s.payment_status }) };
  }

  try {
    const orderId = s.metadata.order_id;
    const orders = await sb('marketplace_orders?id=eq.' + encodeURIComponent(orderId) +
      '&select=id,status,kind,offering_id,buyer_email,buyer_account_id&limit=1');
    const order = orders && orders[0];
    if (!order) return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, no_order: true }) };
    if (order.status === 'paid') return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, already_paid: true }) };

    // Mark paid — idempotent guard: only flip a still-pending order.
    const paid = await sb('marketplace_orders?id=eq.' + order.id + '&status=eq.pending', 'PATCH', {
      status: 'paid', paid_at: new Date().toISOString(), stripe_payment_intent: s.payment_intent || null
    }, 'return=representation');
    if (!paid || !paid.length) {
      return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, race_or_no_change: true }) };
    }

    // Confirm the booking + book the slot.
    const bookings = await sb('marketplace_bookings?order_id=eq.' + order.id +
      '&select=id,availability_id,seller_id,starts_at,ends_at,buyer_email,buyer_timezone,topic,kind,toolkit_included&limit=1');
    const booking = bookings && bookings[0];
    let seller = null, sellerEmail = null;
    if (booking) {
      const sel = await sb('marketplace_sellers?id=eq.' + booking.seller_id +
        '&select=display_name,timezone,meeting_instructions,account_id&limit=1');
      seller = sel && sel[0] ? sel[0] : null;
      const meetingUrl = seller ? (seller.meeting_instructions || null) : null;
      await sb('marketplace_bookings?id=eq.' + booking.id, 'PATCH',
        { status: 'confirmed', meeting_url: meetingUrl }, 'return=minimal').catch(function () {});
      if (booking.availability_id) {
        await sb('marketplace_availability?id=eq.' + booking.availability_id, 'PATCH',
          { status: 'booked', hold_expires_at: null }, 'return=minimal').catch(function () {});
      }
      if (seller && seller.account_id) {
        const sa = await sb('accounts?id=eq.' + seller.account_id + '&select=email&limit=1').catch(function () { return null; });
        sellerEmail = sa && sa[0] ? sa[0].email : null;
      }
    }

    // Bundle -> grant toolkit access (reuses template_purchases + template-download.js).
    if (order.kind === 'bundle') {
      const items = await sb('marketplace_order_items?order_id=eq.' + order.id +
        '&item_type=eq.toolkit&select=template_id,amount_cents&limit=1');
      const tk = items && items[0];
      if (tk && tk.template_id) {
        const accountId = await ensureAccount(order.buyer_email, order.buyer_account_id);
        if (accountId) {
          await sb('template_purchases?on_conflict=account_id,template_id', 'POST', {
            account_id: accountId,
            template_id: tk.template_id,
            amount_cents: tk.amount_cents,
            stripe_session_id: s.id
          }, 'resolution=merge-duplicates,return=minimal').catch(function () {});
        }
      }
    }

    // Notifications (best-effort — never fail the webhook on an email issue).
    if (booking) {
      const base = (process.env.PUBLIC_BASE_URL || 'https://thinkbeyondpractice.com').replace(/\/$/, '');
      try {
        await sendBuyerConfirmation({
          toEmail: booking.buyer_email,
          bookingId: booking.id,
          sellerName: seller ? seller.display_name : null,
          startIso: booking.starts_at, endIso: booking.ends_at,
          buyerTz: booking.buyer_timezone || (seller ? seller.timezone : 'America/New_York'),
          meetingUrl: seller ? seller.meeting_instructions : null,
          kind: booking.kind, toolkitIncluded: !!booking.toolkit_included,
          signInUrl: base + '/platform.html'
        });
      } catch (e) { console.error('buyer confirmation email failed:', e.message); }
      if (sellerEmail) {
        try {
          await sendSellerNotification({
            toEmail: sellerEmail,
            sellerName: seller ? seller.display_name : null,
            buyerEmail: booking.buyer_email,
            startIso: booking.starts_at,
            sellerTz: seller ? seller.timezone : 'America/New_York',
            kind: booking.kind, toolkitIncluded: !!booking.toolkit_included,
            topic: booking.topic
          });
        } catch (e) { console.error('seller notification email failed:', e.message); }
      }
    }

    return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, fulfilled: order.id }) };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};

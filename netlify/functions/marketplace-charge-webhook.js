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

const { sb } = require('./_lib/marketplace');

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
      '&select=id,availability_id,seller_id&limit=1');
    const booking = bookings && bookings[0];
    if (booking) {
      // meeting instructions live on the seller row
      let meetingUrl = null;
      const sel = await sb('marketplace_sellers?id=eq.' + booking.seller_id + '&select=meeting_instructions&limit=1');
      if (sel && sel[0]) meetingUrl = sel[0].meeting_instructions || null;
      await sb('marketplace_bookings?id=eq.' + booking.id, 'PATCH',
        { status: 'confirmed', meeting_url: meetingUrl }, 'return=minimal').catch(function () {});
      if (booking.availability_id) {
        await sb('marketplace_availability?id=eq.' + booking.availability_id, 'PATCH',
          { status: 'booked', hold_expires_at: null }, 'return=minimal').catch(function () {});
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

    return { statusCode: 200, headers: H, body: JSON.stringify({ received: true, fulfilled: order.id }) };
  } catch (err) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};

// Ensure a (free) account exists for the buyer so toolkit entitlement can be keyed
// to an account_id. Nonmembers who buy a bundle get a lightweight account here;
// they claim it via the normal sign-in link. Idempotent on email.
async function ensureAccount(email, knownId) {
  if (knownId) return knownId;
  const clean = String(email || '').toLowerCase().trim();
  if (!clean) return null;
  const existing = await sb('accounts?email=eq.' + encodeURIComponent(clean) + '&select=id&limit=1');
  if (existing && existing[0]) return existing[0].id;
  const rows = await sb('accounts', 'POST', { email: clean, tier: 'free' }, 'return=representation').catch(function () { return null; });
  if (rows && rows[0]) return rows[0].id;
  const again = await sb('accounts?email=eq.' + encodeURIComponent(clean) + '&select=id&limit=1');
  return again && again[0] ? again[0].id : null;
}

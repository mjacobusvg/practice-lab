// netlify/functions/create-template-checkout.js
// Starts a one-time Stripe Checkout for a single paid template (how a FREE-tier
// member buys just one instead of joining). Paying members already have every
// template, so they never need this. The price is the template's own price_cents
// (per-template pricing), set by the admin — nothing is sellable until that is
// non-zero. On success, stripe-webhook.js records the purchase and
// template-download.js unlocks the file for that member.
//
// Auth: a valid signed session token (Bearer or body.token).
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
// Body: { token, template_id, success_url, cancel_url }

const { verifyToken } = require('./_lib/session');

exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY || !process.env.STRIPE_SECRET_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing env' }) };

  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad JSON' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Sign in first' }) };
  const email = String(session.claims.email || '').toLowerCase().trim();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Sign in first' }) };

  const templateId = String(body.template_id || '').trim();
  if (!templateId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'template_id required' }) };
  if (!body.success_url || !body.cancel_url) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'success_url and cancel_url required' }) };

  const sbHeaders = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  try {
    const tplRes = await fetch(URL + '/rest/v1/template_library?id=eq.' + encodeURIComponent(templateId) + '&select=id,title,is_paid,price_cents,member_price_cents,grant_membership_days,visible&limit=1', { headers: sbHeaders });
    const tpls = await tplRes.json();
    const tpl = tpls && tpls[0];
    if (!tpl || !tpl.visible) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Template not found' }) };
    if (!tpl.is_paid || !(tpl.price_cents > 0)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'This template is not for individual sale.' }) };

    // Tiered price. member_price_cents set => a premium item that paying members
    // buy at the reduced price; non-members pay full price_cents. When it is NOT a
    // member-priced item, paying members already get it free and must not be charged.
    const tier = String(session.claims.tier || 'free').toLowerCase();
    const paying = (tier === 'forum' || tier === 'full');
    const memberPriced = tpl.member_price_cents != null && tpl.member_price_cents > 0;
    if (!memberPriced && paying) return { statusCode: 200, headers: CORS, body: JSON.stringify({ already_owned: true }) };
    const unitAmount = (memberPriced && paying) ? tpl.member_price_cents : tpl.price_cents;

    // Already own it? Then no charge.
    const meRes = await fetch(URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=id,stripe_customer_id&limit=1', { headers: sbHeaders });
    const me = (await meRes.json())[0];
    if (me) {
      const owned = await fetch(URL + '/rest/v1/template_purchases?account_id=eq.' + me.id + '&template_id=eq.' + encodeURIComponent(templateId) + '&select=id&limit=1', { headers: sbHeaders });
      if ((await owned.json()).length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ already_owned: true }) };
    }

    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    // A NON-member buying a template that grants membership days gets a free trial
    // of Full started off their saved card (webhook does the actual subscription).
    // For that we need a persistent Stripe customer and setup_future_usage so the
    // card is reusable. Every other purchase stays a simple one-off.
    const granting = !paying && tpl.grant_membership_days > 0;

    const params = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: String(tpl.title || 'Template').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 120) || 'Template' },
          unit_amount: unitAmount
        },
        quantity: 1
      }],
      success_url: body.success_url,
      cancel_url: body.cancel_url,
      metadata: { tbp_purchase: 'template', tbp_account_email: email, template_id: templateId }
    };

    if (granting) {
      let customerId = me && me.stripe_customer_id ? me.stripe_customer_id : null;
      if (!customerId) {
        const customer = await stripe.customers.create({ email, metadata: { tbp_account_email: email } });
        customerId = customer.id;
        if (me) await fetch(URL + '/rest/v1/accounts?id=eq.' + me.id, { method: 'PATCH', headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ stripe_customer_id: customerId }) });
      }
      params.customer = customerId;
      params.payment_intent_data = { setup_future_usage: 'off_session' };
      params.metadata.tbp_grant_full_days = String(tpl.grant_membership_days);
    } else {
      params.customer_email = email;
    }

    const checkout = await stripe.checkout.sessions.create(params);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: checkout.url }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

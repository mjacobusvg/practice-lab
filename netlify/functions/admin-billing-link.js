// netlify/functions/admin-billing-link.js
//
// One-off helper to get a member a Stripe BILLING PORTAL link by email, so they
// can update the card on an EXISTING subscription. Use this for a past_due
// member (card failing but the subscription is still alive) — updating the card
// lets Stripe retry and recover it, with no new subscription and no rate change.
//
// (Contrast with admin-legacy-link.js, which is for a member whose subscription
// is already dead and needs a fresh one.)
//
// Looks up the member's stripe_customer_id from their account and mints a portal
// session. Read-only against our data; it never changes a tier or a charge.
//
// POST body: { secret, email, return_url? }
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKFILL_SECRET

exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  if (!process.env.BACKFILL_SECRET || body.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
  }
  const email = (body.email || '').toLowerCase().trim();
  if (!email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'email required' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!process.env.STRIPE_SECRET_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  try {
    const acctRes = await fetch(SUPABASE_URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=stripe_customer_id,name,tier&limit=1',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
    const accts = acctRes.ok ? await acctRes.json() : [];
    const acct = accts[0] || null;
    if (!acct) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No account for that email' }) };
    if (!acct.stripe_customer_id) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'Account has no Stripe customer linked — needs a new subscription (use admin-legacy-link), not a card update.', name: acct.name, tier: acct.tier }) };
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: acct.stripe_customer_id,
      return_url: body.return_url || 'https://thinkbeyondpractice.com/platform'
    });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: portal.url, name: acct.name, tier: acct.tier }, null, 2) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

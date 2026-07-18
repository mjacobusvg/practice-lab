// netlify/functions/create-billing-portal.js
//
// Creates a Stripe Billing Portal session so a member can self-manage their
// subscription (update card, cancel, switch plan) on Stripe's hosted page. This
// replaces the member-management surface Circle used to provide.
//
// Auth: requires a valid signed session token (Bearer or body.token). The customer
// is resolved from the member's own account, never from client input.
//
// Works for any member with a Stripe customer on file, including the legacy
// Circle-created subscriptions (they live in the same account).
//
// POST body: { return_url, token? }
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyToken } = require('./_lib/session');

exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (body.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const v = verifyToken(token);
  if (!v.valid) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not authenticated', reason: v.reason }) };
  const email = (v.claims.email || '').toLowerCase().trim();
  if (!email) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'No email in session' }) };
  if (!body.return_url) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'return_url required' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!process.env.STRIPE_SECRET_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  try {
    const acctRes = await fetch(SUPABASE_URL + '/rest/v1/accounts?email=eq.' + encodeURIComponent(email) + '&select=stripe_customer_id&limit=1',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
    const accts = acctRes.ok ? await acctRes.json() : [];
    const customerId = accts[0] && accts[0].stripe_customer_id;
    if (!customerId) {
      // No Stripe customer linked to this account yet (e.g. a comped/manual member,
      // or a customer link not yet backfilled). Most members already have one, since
      // Circle checkouts create the customer in our own Stripe. Give a calm,
      // accurate message instead of an error dead-end. (200 so the client shows it.)
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ notice: 'We could not find a billing profile linked to your account. If you believe you are on a paid plan, reply to support@thinkbeyondpractice.com and we will sort it out. Nothing about your access changes in the meantime.' }) };
    }

    const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: body.return_url });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: portal.url }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

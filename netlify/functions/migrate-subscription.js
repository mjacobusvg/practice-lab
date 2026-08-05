// netlify/functions/migrate-subscription.js
//
// STAGED, NOT FOR ROUTINE USE. One-at-a-time migration of a Circle-created Stripe
// subscription onto a fresh Michael-OWNED subscription, in preparation for
// disconnecting Circle. Runs only when we are ready to sever Circle.
//
// WHY: the existing member subscriptions were created by Circle's Connect platform
// and carry application_fee_percent:1 routed to Circle. Our own account key can
// manage them (cancel/edit) but CANNOT remove that platform fee (verified: Stripe
// rejects application_fee changes from a non-platform key). So the clean cutover is
// to recreate each as an owned subscription with no platform fee, reusing the
// member's existing card, then cancel the Circle one.
//
// The migration mechanics live in _lib/migrate-core.js (migrateOne), shared with
// the batch runner migrate-batch-scheduled.js so both use one tested code path.
//
// SAFE BY DEFAULT: dry_run is true unless explicitly false. A dry run reads Stripe
// and returns the exact plan without creating or canceling anything.
//
// POST body: { secret, subscription_id (required), dry_run (default true) }
// Env: STRIPE_SECRET_KEY, BACKFILL_SECRET

const { migrateOne } = require('./_lib/migrate-core');

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
  if (body.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
  }
  if (!body.subscription_id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'subscription_id required (migrate one at a time)' }) };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const dryRun = body.dry_run !== false;
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  try {
    const r = await migrateOne(stripe, body.subscription_id, { dryRun });

    if (r.status === 'skipped') {
      if (r.reason === 'not_active') {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Refusing to migrate a non-active subscription (' + (r.detail || '') + ')' }) };
      }
      if (r.reason === 'already_owned') {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'This subscription is already an owned subscription; nothing to migrate' }) };
      }
      if (r.reason === 'no_card') {
        return { statusCode: 409, headers: CORS, body: JSON.stringify({ error: 'No default payment method on customer; migrate this one manually', plan: r.plan }) };
      }
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Skipped: ' + r.reason }) };
    }

    if (r.status === 'planned') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ dry_run: true, plan: r.plan }, null, 2) };
    }

    // migrated
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        dry_run: false,
        migrated: true,
        old_subscription: r.old_subscription,
        old_now_cancels_at_period_end: r.old_now_cancels_at_period_end,
        new_subscription: r.new_subscription,
        new_status: r.new_status,
        new_first_charge_at: r.new_first_charge_at,
        owned_price: r.owned_price
      }, null, 2)
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

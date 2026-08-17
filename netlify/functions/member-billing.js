// netlify/functions/member-billing.js
//
// Admin-only billing detail for ONE member, powering the billing panel on the
// member profile in platform.html.
//
// SECURITY: isAdmin() in the browser only decides whether to DRAW the panel. This
// function is the actual boundary. It verifies the caller's Supabase session
// server-side, then re-reads is_admin from the accounts table with the service
// key — it never trusts an is_admin flag sent by the client. A non-admin session
// (or a forged one) gets 403 and no billing data.
//
// POST { access_token, account_id } -> { billing: {...} }

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

  const token = body.access_token;
  const accountId = body.account_id;
  if (!token || !accountId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'access_token and account_id required' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  async function rest(path) {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    return res.ok ? res.json() : [];
  }

  // 1) Who is calling? Ask Supabase to validate the session token itself, so an
  //    expired or forged token cannot get past this point.
  let uid = null;
  try {
    const who = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token }
    });
    if (!who.ok) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not signed in' }) };
    const user = await who.json();
    uid = user && user.id;
  } catch (e) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not signed in' }) };
  }
  if (!uid) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Not signed in' }) };

  // 2) Is that caller actually an admin? Read it from the database, not the client.
  const caller = await rest('accounts?auth_id=eq.' + encodeURIComponent(uid) + '&select=is_admin&limit=1');
  if (!caller[0] || caller[0].is_admin !== true) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admins only' }) };
  }

  // 3) Load the target member and their subscriptions.
  const rows = await rest(
    'accounts?id=eq.' + encodeURIComponent(accountId) +
    '&select=id,email,name,tier,tier_override,tier_override_reason,tier_override_expires_at,' +
    'stripe_customer_id,created_at,last_seen_at,' +
    'subscriptions(status,amount_cents,billing_interval,is_grandfathered,current_period_end,canceled_at)&limit=1'
  );
  const a = rows[0];
  if (!a) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'No such member' }) };

  const ACCESS = ['active', 'trialing', 'past_due'];
  const live = (a.subscriptions || []).filter(function (s) {
    return ACCESS.indexOf(s.status) !== -1 && s.amount_cents != null;
  });

  // Collapse a migration pair (old subscription + its trialing replacement, same
  // price) into the single plan it really is. Two DIFFERENT prices stay separate,
  // because that is someone genuinely holding two memberships.
  const seen = {};
  const plans = [];
  live.forEach(function (s) {
    const k = s.amount_cents + '|' + s.billing_interval;
    if (seen[k]) return;
    seen[k] = true;
    plans.push({
      label: '$' + Math.round(s.amount_cents / 100) + (s.billing_interval === 'year' ? '/yr' : '/mo') +
             (s.is_grandfathered ? ' grandfathered' : ''),
      amount_cents: s.amount_cents,
      interval: s.billing_interval,
      renews: s.current_period_end,
      ending: !!s.canceled_at
    });
  });
  plans.sort(function (x, y) { return y.amount_cents - x.amount_cents; });

  const comped = !!a.tier_override;
  const failing = live.some(function (s) { return s.status === 'past_due'; });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      billing: {
        email: a.email,
        access: comped ? a.tier_override : a.tier,
        granted_tier: a.tier,
        state: failing ? 'card failing' : (plans.length ? 'paying' : (comped ? 'comped' : 'free')),
        plan: plans.length
          ? plans.map(function (p) { return p.label; }).join(' + ')
          : (comped ? 'comped — not paying' : 'no paid plan'),
        renews: plans.length ? plans[0].renews : null,
        ending: plans.some(function (p) { return p.ending; }),
        comped: comped,
        comp_reason: a.tier_override_reason || null,
        comp_expires: a.tier_override_expires_at || null,
        monthly_cents: plans.reduce(function (n, p) {
          return n + (p.interval === 'year' ? Math.round(p.amount_cents / 12) : p.amount_cents);
        }, 0),
        stripe_customer_id: a.stripe_customer_id || null,
        last_seen_at: a.last_seen_at || null
      }
    })
  };
};

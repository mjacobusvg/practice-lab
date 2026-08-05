// netlify/functions/migrate-batch-scheduled.js
//
// Batch driver for the Circle -> owned Stripe subscription migration. Reads a
// worklist from the Supabase table public.sub_migration_queue and processes a
// few rows per run using the shared _lib/migrate-core.js (migrateOne), the exact
// same tested code path as the one-at-a-time migrate-subscription.js endpoint.
//
// WHY A SCHEDULED RUNNER: the Stripe API key needed to *create* subscriptions
// lives only in this server's env; the migration therefore has to run here, not
// from an external caller. The queue table is the control surface: an admin
// inserts rows (mode 'dry' to preview, 'live' to execute) and reads results back
// from the same rows. Each row is claimed atomically (status queued -> processing)
// so overlapping cron runs never double-process.
//
// Row lifecycle: queued -> processing -> done | skipped | error
//   mode 'dry'  : migrateOne dry-run; result.plan stored, nothing created/canceled
//   mode 'live' : creates the owned sub + sets the Circle sub to cancel_at_period_end
//
// Cron: every minute (see netlify.toml). Processes BATCH_LIMIT rows per run, so a
// full 38-member batch drains in well under an hour. Idle runs (no queued rows)
// are a no-op. Remove the schedule from netlify.toml once the cutover is done.
//
// Manual trigger (optional): POST { secret } with BACKFILL_SECRET to run one pass
// immediately instead of waiting for the next minute.
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKFILL_SECRET

const { migrateOne } = require('./_lib/migrate-core');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BATCH_LIMIT = 3; // rows per run; keeps each invocation well within the time limit

function sb(path, init) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(init && init.headers)
    }
  });
}

exports.handler = async function (event) {
  // Manual trigger requires the shared secret; scheduled invocations (no POST
  // body / no httpMethod) run without one.
  if (event && event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) {}
    if (body.secret !== process.env.BACKFILL_SECRET) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Invalid secret' }) };
    }
  }

  if (!process.env.STRIPE_SECRET_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  // 1) Pull the next queued rows (oldest first).
  const queuedRes = await sb('sub_migration_queue?status=eq.queued&order=created_at.asc&limit=' + BATCH_LIMIT, {});
  const queued = queuedRes.ok ? await queuedRes.json() : [];
  if (!queued.length) {
    return { statusCode: 200, body: JSON.stringify({ processed: 0, note: 'no queued rows' }) };
  }

  const outcomes = [];
  for (const row of queued) {
    // 2) Claim the row atomically: only flip it if it is still 'queued'. If the
    //    conditional PATCH returns no row, another run already claimed it.
    const claimRes = await sb(
      'sub_migration_queue?subscription_id=eq.' + encodeURIComponent(row.subscription_id) + '&status=eq.queued',
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'processing', attempts: (row.attempts || 0) + 1 })
      }
    );
    const claimed = claimRes.ok ? await claimRes.json() : [];
    if (!claimed.length) continue; // lost the race; skip

    const patch = { ran_at: new Date().toISOString() };
    try {
      const r = await migrateOne(stripe, row.subscription_id, { dryRun: row.mode !== 'live' });
      if (r.status === 'planned') {
        patch.status = 'done';
        patch.result = r;
        patch.error = null;
      } else if (r.status === 'migrated') {
        patch.status = 'done';
        patch.result = r;
        patch.error = null;
      } else if (r.status === 'skipped') {
        patch.status = 'skipped';
        patch.result = r;
        patch.error = r.reason + (r.detail ? (' (' + r.detail + ')') : '');
      } else {
        patch.status = 'error';
        patch.error = 'unknown result status ' + r.status;
      }
      outcomes.push({ subscription_id: row.subscription_id, mode: row.mode, status: patch.status });
    } catch (e) {
      patch.status = 'error';
      patch.error = String(e && e.message ? e.message : e);
      outcomes.push({ subscription_id: row.subscription_id, mode: row.mode, status: 'error', error: patch.error });
    }

    // 3) Write the outcome back to the row.
    await sb('sub_migration_queue?subscription_id=eq.' + encodeURIComponent(row.subscription_id), {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
  }

  return { statusCode: 200, body: JSON.stringify({ processed: outcomes.length, outcomes }) };
};

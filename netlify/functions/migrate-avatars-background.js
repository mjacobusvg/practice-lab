// netlify/functions/migrate-avatars-background.js
//
// One-time (re-runnable) migration: member avatars are currently HOTLINKED to
// Circle's CDN (app.circle.so Rails ActiveStorage redirect URLs). When Circle is
// shut off, every one of those images breaks. This copies each Circle avatar into
// our own Supabase Storage ('avatars' bucket) and repoints accounts.avatar_url at
// the Supabase public URL, so the platform no longer depends on Circle for images.
//
// Runs in the background (15-min limit). Secret-gated. Idempotent: an account's
// avatar_url is only updated AFTER its image is safely stored, so a failed image
// keeps its Circle URL and is retried on the next run. Safe to run repeatedly.
//
// Trigger: POST { secret } to /.netlify/functions/migrate-avatars-background
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKFILL_SECRET

const TIME_BUDGET_MS = 800 * 1000;

function extFromContentType(ct) {
  const c = (ct || '').toLowerCase();
  if (c.indexOf('png') !== -1) return 'png';
  if (c.indexOf('jpeg') !== -1 || c.indexOf('jpg') !== -1) return 'jpg';
  if (c.indexOf('webp') !== -1) return 'webp';
  if (c.indexOf('gif') !== -1) return 'gif';
  if (c.indexOf('svg') !== -1) return 'svg';
  return null;
}

exports.handler = async function (event) {
  const started = Date.now();

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

  if (!process.env.BACKFILL_SECRET || body.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, body: 'Missing Supabase env vars' };
  }

  const authHeaders = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY };

  // Accounts whose avatar is still hosted on Circle.
  let accounts;
  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/accounts?select=id,name,avatar_url&avatar_url=ilike.*app.circle.so*&limit=1000',
      { headers: authHeaders }
    );
    if (!res.ok) throw new Error('accounts fetch ' + res.status + ': ' + (await res.text()).slice(0, 200));
    accounts = await res.json();
  } catch (e) {
    console.error('avatar-migrate: cannot load accounts:', e.message);
    return { statusCode: 500, body: 'Load failed' };
  }

  console.log('avatar-migrate: ' + accounts.length + ' Circle-hosted avatars to move');

  const stats = { total: accounts.length, migrated: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < accounts.length; i++) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      console.log('avatar-migrate: time budget reached, stopping at ' + i + '/' + accounts.length + ' (re-run to finish)');
      break;
    }
    const acct = accounts[i];
    try {
      // 1. Fetch the image from Circle (follows the Rails redirect to the blob).
      const imgRes = await fetch(acct.avatar_url, { redirect: 'follow' });
      const ct = imgRes.headers.get('content-type') || '';
      if (!imgRes.ok || ct.indexOf('image/') !== 0) {
        console.log('avatar-migrate: skip ' + acct.id + ' (' + acct.name + ') status=' + imgRes.status + ' ct=' + ct);
        stats.skipped++;
        continue;
      }
      const ext = extFromContentType(ct);
      if (!ext) {
        console.log('avatar-migrate: skip ' + acct.id + ' unsupported ct=' + ct);
        stats.skipped++;
        continue;
      }
      const bytes = Buffer.from(await imgRes.arrayBuffer());
      if (!bytes.length) { stats.skipped++; continue; }

      // 2. Upload into the public 'avatars' bucket at avatars/<account_id>.<ext>.
      const objectPath = acct.id + '.' + ext;
      const upRes = await fetch(SUPABASE_URL + '/storage/v1/object/avatars/' + objectPath, {
        method: 'POST',
        headers: Object.assign({}, authHeaders, { 'Content-Type': ct, 'x-upsert': 'true' }),
        body: bytes
      });
      if (!upRes.ok) {
        console.error('avatar-migrate: upload failed ' + acct.id + ' ' + upRes.status + ': ' + (await upRes.text()).slice(0, 200));
        stats.errors++;
        continue;
      }

      // 3. Repoint the account at the Supabase public URL (only after a good upload).
      const publicUrl = SUPABASE_URL + '/storage/v1/object/public/avatars/' + objectPath;
      const patchRes = await fetch(SUPABASE_URL + '/rest/v1/accounts?id=eq.' + encodeURIComponent(acct.id), {
        method: 'PATCH',
        headers: Object.assign({}, authHeaders, { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ avatar_url: publicUrl })
      });
      if (!patchRes.ok) {
        console.error('avatar-migrate: repoint failed ' + acct.id + ' ' + patchRes.status + ': ' + (await patchRes.text()).slice(0, 200));
        stats.errors++;
        continue;
      }

      stats.migrated++;
      console.log('avatar-migrate: moved ' + acct.name + ' -> ' + objectPath);
    } catch (e) {
      console.error('avatar-migrate: error ' + acct.id + ': ' + e.message);
      stats.errors++;
    }
  }

  console.log('avatar-migrate DONE: ' + JSON.stringify(stats));
  return { statusCode: 202, body: JSON.stringify(stats) };
};

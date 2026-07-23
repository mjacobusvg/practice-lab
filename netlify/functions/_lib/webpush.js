// netlify/functions/_lib/webpush.js
//
// Web Push sender (RFC 8291 payload encryption + RFC 8292 VAPID) built on the
// `web-push` library. This is the bridge that turns an in-app notification into
// a notification that lights up a member's PHONE, even when the platform tab is
// closed. notify.js and messages.js call sendToAccounts() right after they write
// their in-app rows.
//
// Requires three env vars (set in Netlify):
//   VAPID_PUBLIC_KEY   — the base64url public key (also embedded in platform.html)
//   VAPID_PRIVATE_KEY  — the base64url private key (SECRET; server only)
//   VAPID_SUBJECT      — a mailto: or https: contact, e.g. mailto:michael@thinkbeyondpractice.com
//
// Everything here is best-effort and never throws to the caller: a push failure
// must never break posting, commenting, or messaging. Dead subscriptions
// (410 Gone / 404) are pruned automatically so the table stays clean.

let webpush = null;
let configured = false;

function getWebpush() {
  if (webpush) return webpush;
  try { webpush = require('web-push'); } catch (e) { return null; }
  return webpush;
}

// Configure VAPID once per cold start. Returns false if keys are missing so
// callers can no-op cleanly (the feature is simply "off" until keys are set).
function ensureConfigured() {
  if (configured) return true;
  const wp = getWebpush();
  if (!wp) return false;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:michael@thinkbeyondpractice.com';
  if (!pub || !priv) return false;
  try {
    wp.setVapidDetails(subject, pub, priv);
    configured = true;
    return true;
  } catch (e) {
    console.log('webpush VAPID config error:', e && e.message);
    return false;
  }
}

function sbEnv() {
  return { URL: process.env.SUPABASE_URL, KEY: process.env.SUPABASE_SERVICE_KEY };
}

async function sbFetch(path, method, body, prefer) {
  const { URL, KEY } = sbEnv();
  if (!URL || !KEY) return null;
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(URL + '/rest/v1/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error('sb ' + res.status + ': ' + text.slice(0, 150));
  return text ? JSON.parse(text) : null;
}

// TEMP diagnostic: record each send attempt to push_debug so we can see, from a
// real event, whether the function is configured, found subscriptions, and what
// the push service returned. Best-effort; never throws. Remove once verified.
async function logDebug(row) {
  try { await sbFetch('push_debug', 'POST', row, 'return=minimal'); } catch (e) { /* ignore */ }
}

// Send one payload to every enabled subscription belonging to the given account
// ids. `payload` = { title, body, url, tag }. Fire-and-forget from the caller's
// perspective; we await internally only so the serverless function stays alive
// long enough to deliver. Returns { sent, pruned } counts (useful in logs).
async function sendToAccounts(accountIds, payload) {
  const ctx = (payload && (payload.tag || payload.title)) || 'unknown';
  try {
    const ids = (accountIds || []).filter(Boolean);
    if (!ids.length) { await logDebug({ context: ctx, configured: false, module_ok: !!getWebpush(), env_ok: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY), sub_count: 0, sent: 0, pruned: 0, errors: 'no account ids' }); return { sent: 0, pruned: 0 }; }
    const moduleOk = !!getWebpush();
    const envOk = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
    if (!ensureConfigured()) { // keys not set yet / module missing -> silently off
      await logDebug({ context: ctx, configured: false, module_ok: moduleOk, env_ok: envOk, sub_count: 0, sent: 0, pruned: 0, errors: 'ensureConfigured=false' });
      return { sent: 0, pruned: 0 };
    }
    const wp = getWebpush();

    const inList = ids.map(function (i) { return String(i); }).join(',');
    const subs = await sbFetch(
      'push_subscriptions?enabled=is.true&account_id=in.(' + inList + ')&select=id,endpoint,p256dh,auth',
      'GET'
    );
    if (!subs || !subs.length) { await logDebug({ context: ctx, configured: true, module_ok: moduleOk, env_ok: envOk, sub_count: 0, sent: 0, pruned: 0, errors: 'no subscriptions for ' + inList }); return { sent: 0, pruned: 0 }; }

    const data = JSON.stringify({
      title: payload.title || 'Think Beyond Practice',
      body: payload.body || '',
      url: payload.url || 'https://thinkbeyondpractice.com/platform.html',
      tag: payload.tag || 'tbp'
    });

    let sent = 0;
    const dead = [];
    const errs = [];
    // Modest concurrency; the recipient set per event is small (post fan-out is
    // the largest and is still only the active member base).
    const CONC = 10;
    for (let i = 0; i < subs.length; i += CONC) {
      const batch = subs.slice(i, i + CONC);
      await Promise.all(batch.map(function (s) {
        const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        return wp.sendNotification(subscription, data, { TTL: 86400 })
          .then(function () { sent++; })
          .catch(function (err) {
            const code = err && err.statusCode;
            errs.push('id' + s.id + ':' + code + ':' + String(err && (err.body || err.message)).slice(0, 120));
            // 404/410 => the push service says this endpoint is gone for good.
            if (code === 404 || code === 410) dead.push(s.id);
            else console.log('webpush send error (' + code + '):', err && err.message);
          });
      }));
    }

    // Prune dead endpoints so we never keep retrying them.
    if (dead.length) {
      try {
        await sbFetch('push_subscriptions?id=in.(' + dead.join(',') + ')', 'DELETE', null, 'return=minimal');
      } catch (e) { /* prune is best-effort */ }
    }

    await logDebug({ context: ctx, configured: true, module_ok: moduleOk, env_ok: envOk, sub_count: subs.length, sent: sent, pruned: dead.length, errors: errs.join(' | ') || null });
    return { sent: sent, pruned: dead.length };
  } catch (e) {
    await logDebug({ context: ctx, configured: null, module_ok: !!getWebpush(), env_ok: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY), sub_count: null, sent: 0, pruned: 0, errors: 'THROW: ' + (e && e.message) });
    console.log('sendToAccounts error:', e && e.message);
    return { sent: 0, pruned: 0 };
  }
}

module.exports = { sendToAccounts, ensureConfigured };

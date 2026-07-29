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

// Send one payload to every enabled subscription belonging to the given account
// ids. `payload` = { title, body, url, tag }. Fire-and-forget from the caller's
// perspective; we await internally only so the serverless function stays alive
// long enough to deliver. Returns { sent, pruned } counts (useful in logs).
async function sendToAccounts(accountIds, payload) {
  try {
    const ids = (accountIds || []).filter(Boolean);
    if (!ids.length) return { sent: 0, pruned: 0 };
    if (!ensureConfigured()) return { sent: 0, pruned: 0 }; // keys not set yet -> silently off
    const wp = getWebpush();

    const inList = ids.map(function (i) { return String(i); }).join(',');
    const subs = await sbFetch(
      'push_subscriptions?enabled=is.true&account_id=in.(' + inList + ')&select=id,endpoint,p256dh,auth,fail_count',
      'GET'
    );
    if (!subs || !subs.length) return { sent: 0, pruned: 0 };

    const data = JSON.stringify({
      title: payload.title || 'Think Beyond Practice',
      body: payload.body || '',
      url: payload.url || 'https://thinkbeyondpractice.com/platform.html',
      tag: payload.tag || 'tbp'
    });

    const nowIso = new Date().toISOString();
    // Persist the push-service outcome per subscription so a device that silently
    // never shows notifications (push ACCEPTED by the service, dropped by the OS)
    // is diagnosable after the fact: last_status 201/204 = accepted (look at the
    // phone's app notification settings / Doze), a 4xx/5xx + last_error = the real
    // rejection. Best-effort; a logging write must never affect delivery.
    function record(sub, ok, status, errMsg) {
      var patch = ok
        ? { last_status: (status || 201), last_error: null, last_sent_at: nowIso, fail_count: 0 }
        : { last_status: (status || 0), last_error: String(errMsg || '').slice(0, 300), last_sent_at: nowIso, fail_count: (sub.fail_count || 0) + 1 };
      return sbFetch('push_subscriptions?id=eq.' + sub.id, 'PATCH', patch, 'return=minimal').catch(function () {});
    }

    let sent = 0;
    const dead = [];
    // Modest concurrency; the recipient set per event is small (post fan-out is
    // the largest and is still only the active member base).
    const CONC = 10;
    for (let i = 0; i < subs.length; i += CONC) {
      const batch = subs.slice(i, i + CONC);
      await Promise.all(batch.map(function (s) {
        const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
        // urgency:'high' tells the push service to deliver immediately instead of
        // batching for a device maintenance window. Without it, Android Doze holds
        // normal-urgency pushes for ~10-15 min when the phone is idle/locked.
        return wp.sendNotification(subscription, data, { TTL: 86400, urgency: 'high' })
          .then(function (res) { sent++; return record(s, true, res && res.statusCode); })
          .catch(function (err) {
            const code = err && err.statusCode;
            // 404/410 => the push service says this endpoint is gone for good.
            if (code === 404 || code === 410) { dead.push(s.id); return; }
            console.log('webpush send error (' + code + '):', err && err.message);
            return record(s, false, code, err && err.message);
          });
      }));
    }

    // Prune dead endpoints so we never keep retrying them.
    if (dead.length) {
      try {
        await sbFetch('push_subscriptions?id=in.(' + dead.join(',') + ')', 'DELETE', null, 'return=minimal');
      } catch (e) { /* prune is best-effort */ }
    }

    return { sent: sent, pruned: dead.length };
  } catch (e) {
    console.log('sendToAccounts error:', e && e.message);
    return { sent: 0, pruned: 0 };
  }
}

module.exports = { sendToAccounts, ensureConfigured };

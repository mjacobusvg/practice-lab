// netlify/functions/_lib/notify.js
//
// Shared notification pipeline used by the post/comment/DM hooks. Every event
// creates IN-APP notification rows (member_notifications) and, per each member's
// email preference, sends a best-effort email. Nothing here throws or blocks the
// caller — a notification failure must never break posting/commenting/messaging.
//
// Member = accounts with tier 'forum' or 'full' (the tiers that can read posts).

const { sendToAccounts } = require('./webpush');

const MEMBER_TIERS = "tier=in.(forum,full)";

const PLATFORM_BASE = 'https://thinkbeyondpractice.com/platform.html';

function sbEnv() {
  return { URL: process.env.SUPABASE_URL, KEY: process.env.SUPABASE_SERVICE_KEY };
}

async function sb(path, method, body, prefer) {
  const { URL, KEY } = sbEnv();
  if (!URL || !KEY) return null;
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(URL + '/rest/v1/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error('sb ' + res.status + ': ' + text.slice(0, 150));
  return text ? JSON.parse(text) : null;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Strip Markdown to plain prose and trim to a snippet (for email previews).
function makeSnippet(md, max) {
  let t = String(md == null ? '' : md)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`{1,3}/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/[*_]/g, '')
    .replace(/^\s*[-–—]{3,}\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  max = max || 220;
  if (t.length <= max) return t;
  let cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return cut + '…';
}

// A branded post-announcement card (title, author + avatar, space, snippet, CTA).
function postEmailCard(opts) {
  const title = esc(opts.title || '');
  const author = esc(opts.author || 'A member');
  const url = opts.url;
  const avatar = opts.avatarUrl
    ? '<img src="' + esc(opts.avatarUrl) + '" width="40" height="40" style="border-radius:50%;display:block" alt="">'
    : '<div style="width:40px;height:40px;border-radius:50%;background:#0d3b4f;color:#fff;font-weight:700;font-size:16px;line-height:40px;text-align:center">' + esc((String(opts.author || '?')[0] || '?').toUpperCase()) + '</div>';
  const meta = opts.space
    ? '<strong style="color:#1a1a1a">' + author + '</strong><br><span style="color:#777;font-size:13px">Posted in ' + esc(opts.space) + '</span>'
    : '<strong style="color:#1a1a1a">' + author + '</strong>';
  const snippet = opts.snippet
    ? '<p style="font-size:15px;line-height:1.6;color:#333;margin:0 0 22px">' + esc(opts.snippet) + '</p>'
    : '';
  return '' +
    '<div style="max-width:560px;margin:0 auto;font-family:Arial,Helvetica,sans-serif">' +
      '<h1 style="font-size:22px;line-height:1.3;color:#1a1a1a;margin:0 0 16px">' + title + '</h1>' +
      '<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 18px">' +
        '<tr><td style="padding-right:11px;vertical-align:middle">' + avatar + '</td>' +
        '<td style="vertical-align:middle;font-size:14px">' + meta + '</td></tr>' +
      '</table>' +
      snippet +
      '<p style="margin:0"><a href="' + url + '" style="display:inline-block;background:#0d3b4f;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:6px">Read more &rarr;</a></p>' +
    '</div>';
}

const PLATFORM_URL = 'https://thinkbeyondpractice.com/platform.html';
const PREFS_URL = 'https://thinkbeyondpractice.com/email-preferences.html';

// Build the SES client (or null if not configured).
function sesClient() {
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  const region = process.env.SES_AWS_REGION || process.env.SES_REGION || 'us-east-1';
  const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
  return {
    client: new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } }),
    SendEmailCommand: SendEmailCommand,
    from: process.env.SES_FROM || 'Think Beyond Practice <noreply@thinkbeyondpractice.com>'
  };
}

// A per-recipient footer with a no-login link to that member's email preferences
// (choose exactly which emails to get, or unsubscribe from all).
function prefsFooter(email) {
  try {
    const { mintPrefsToken } = require('./prefs-token');
    const link = PREFS_URL + '?t=' + encodeURIComponent(mintPrefsToken(email));
    return '<p style="font-size:12px;color:#888;margin-top:22px;border-top:1px solid #eee;padding-top:12px">' +
      'Choose which emails you get, or unsubscribe: <a href="' + link + '">manage email preferences</a>.</p>';
  } catch (e) { return ''; }
}

// Best-effort email to many recipients via Bcc (used only where per-recipient
// personalization is not needed).
async function emailBcc(toEmails, subject, html) {
  try {
    const list = (toEmails || []).filter(function (e) { return e && String(e).indexOf('@') !== -1; });
    if (!list.length) return;
    const ses = sesClient(); if (!ses) return;
    const to = process.env.NOTIFY_TO || 'noreply@thinkbeyondpractice.com';
    for (let i = 0; i < list.length; i += 45) {
      const chunk = list.slice(i, i + 45);
      await ses.client.send(new ses.SendEmailCommand({
        FromEmailAddress: ses.from,
        Destination: { ToAddresses: [to], BccAddresses: chunk },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } }
      }));
    }
  } catch (e) { console.log('notify email error:', e && e.message); }
}

// Per-recipient email: one message each, so the body can carry that member's own
// preferences link. buildHtml(email) returns the full HTML for that recipient.
async function emailEach(toEmails, subject, buildHtml) {
  try {
    const list = (toEmails || []).filter(function (e) { return e && String(e).indexOf('@') !== -1; });
    if (!list.length) return;
    const ses = sesClient(); if (!ses) return;
    const CONC = 5;
    for (let i = 0; i < list.length; i += CONC) {
      const batch = list.slice(i, i + CONC);
      await Promise.all(batch.map(function (email) {
        return ses.client.send(new ses.SendEmailCommand({
          FromEmailAddress: ses.from,
          Destination: { ToAddresses: [email] },
          Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Html: { Data: buildHtml(email), Charset: 'UTF-8' } } } }
        })).catch(function (e) { console.log('emailEach error for one recipient:', e && e.message); });
      }));
    }
  } catch (e) { console.log('emailEach error:', e && e.message); }
}

// New post -> notify all other members in-app; email members who opted in.
// emailBlast=true only for admin (Michael) posts, so member posts don't email-blast.
async function notifyNewPost(post, actor, opts) {
  try {
    if (!post || !post.id) return;
    const actorId = (actor && actor.id) || '00000000-0000-0000-0000-000000000000';
    const actorName = (actor && actor.name) || 'A member';

    // Audience. Gated posts go to paid tiers only. A post opened to free members
    // (free_visible) is also announced to the free tier, so free members hear
    // about every post they're allowed to read instead of only finding it in
    // Free Reads. The caller may pass free_visible on the post; if not, look it up.
    let tierFilter = MEMBER_TIERS;
    try {
      let isFree = !!(post && post.free_visible);
      if (post.free_visible === undefined) {
        const prow = await sb('forum_posts?id=eq.' + encodeURIComponent(post.id) + '&select=free_visible', 'GET');
        isFree = !!(prow && prow[0] && prow[0].free_visible);
      }
      if (isFree) tierFilter = 'tier=in.(free,forum,full)';
    } catch (e) { /* on any lookup failure, fall back to paid tiers only */ }

    const recips = await sb('accounts?' + tierFilter + '&id=neq.' + actorId + '&select=id,email,notify_email_posts,notify_push_posts', 'GET');
    if (!recips || !recips.length) return;

    const rows = recips.map(function (r) {
      return { user_id: r.id, type: 'post', actor_id: actorId, actor_name: actorName, title: post.title || 'New post', post_id: post.id };
    });
    try { await sb('member_notifications', 'POST', rows, 'return=minimal'); } catch (e) { console.log('notify post in-app:', e && e.message); }

    // Phone push to recipients who have push-for-posts on (default on). Sends
    // only reach devices that actually subscribed; this just honors the type pref.
    try {
      const pushIds = recips.filter(function (r) { return r.notify_push_posts !== false; }).map(function (r) { return r.id; });
      await sendToAccounts(pushIds, {
        title: 'New post from ' + actorName,
        body: post.title || 'A new post was published',
        url: PLATFORM_BASE + '?post=' + encodeURIComponent(post.id),
        tag: 'post-' + post.id
      });
    } catch (e) { console.log('notify post push:', e && e.message); }

    if (opts && opts.emailBlast) {
      const emails = recips.filter(function (r) { return r.notify_email_posts; }).map(function (r) { return r.email; });
      // Enrich to a real post announcement: snippet, space, author avatar.
      // Best-effort — any failure falls back to a title-only card.
      let bodyPlain = '', spaceName = '', avatarUrl = '';
      try {
        const prow = await sb('forum_posts?id=eq.' + encodeURIComponent(post.id) + '&select=body_plain,space_id', 'GET');
        if (prow && prow[0]) {
          bodyPlain = prow[0].body_plain || '';
          if (prow[0].space_id) {
            const srow = await sb('spaces?id=eq.' + encodeURIComponent(prow[0].space_id) + '&select=name', 'GET');
            if (srow && srow[0]) spaceName = srow[0].name || '';
          }
        }
        const arow = await sb('accounts?id=eq.' + encodeURIComponent(actorId) + '&select=avatar_url', 'GET');
        if (arow && arow[0]) avatarUrl = arow[0].avatar_url || '';
      } catch (e) { /* enrichment best-effort */ }
      const card = postEmailCard({
        title: post.title || '', author: actorName, space: spaceName,
        avatarUrl: avatarUrl, snippet: makeSnippet(bodyPlain, 500),
        url: PLATFORM_URL + '?post=' + encodeURIComponent(post.id)
      });
      await emailEach(emails, 'New post: ' + (post.title || 'Think Beyond Practice'), function (email) { return card + prefsFooter(email); });
    }
  } catch (e) { console.log('notifyNewPost error:', e && e.message); }
}

// New comment -> notify the post author + everyone who previously commented on
// that post (minus the commenter). In-app always; email per preference.
async function notifyNewComment(post, commenter) {
  try {
    if (!post || !post.id) return;
    const commenterId = (commenter && commenter.id) || '';
    const commenterName = (commenter && commenter.name) || 'A member';

    const priors = await sb('forum_comments?post_id=eq.' + post.id + '&select=author_id', 'GET');
    const idset = {};
    if (post.author_id) idset[post.author_id] = true;
    (priors || []).forEach(function (c) { if (c.author_id) idset[c.author_id] = true; });
    // Thread followers get comment notifications even if they never commented.
    try {
      const followers = await sb('follows?target_type=eq.post&target_id=eq.' + post.id + '&select=account_id', 'GET');
      (followers || []).forEach(function (f) { if (f.account_id) idset[f.account_id] = true; });
    } catch (e) { /* following is best-effort */ }
    // Admins (the founder) are notified of EVERY comment, community-wide, even on
    // threads they aren't part of, so they can stay on top of activity. Excluded
    // below if the admin is the one commenting.
    try {
      const admins = await sb('accounts?is_admin=eq.true&select=id', 'GET');
      (admins || []).forEach(function (a) { if (a.id) idset[a.id] = true; });
    } catch (e) { /* admin notify best-effort */ }
    delete idset[commenterId];
    const ids = Object.keys(idset);
    if (!ids.length) return;

    const recips = await sb('accounts?id=in.(' + ids.join(',') + ')&select=id,email,notify_email_comments,notify_push_comments', 'GET');
    if (!recips || !recips.length) return;

    const rows = recips.map(function (r) {
      return { user_id: r.id, type: 'comment', actor_id: commenterId || null, actor_name: commenterName, title: post.title || 'a post', post_id: post.id };
    });
    try { await sb('member_notifications', 'POST', rows, 'return=minimal'); } catch (e) { console.log('notify comment in-app:', e && e.message); }

    // Phone push to the post author + thread participants who have push-for-
    // comments on (default on).
    try {
      const pushIds = recips.filter(function (r) { return r.notify_push_comments !== false; }).map(function (r) { return r.id; });
      await sendToAccounts(pushIds, {
        title: commenterName + ' commented',
        body: 'on "' + (post.title || 'a thread') + '"',
        url: PLATFORM_BASE + '?post=' + encodeURIComponent(post.id),
        tag: 'comment-' + post.id
      });
    } catch (e) { console.log('notify comment push:', e && e.message); }

    const emails = recips.filter(function (r) { return r.notify_email_comments; }).map(function (r) { return r.email; });
    const threadUrl = PLATFORM_URL + '?post=' + encodeURIComponent(post.id);
    const body = '<p><strong>' + esc(commenterName) + '</strong> commented on a thread you\'re part of:</p>' +
      '<p style="font-size:16px"><strong>' + esc(post.title || '') + '</strong></p>' +
      '<p><a href="' + threadUrl + '">Read the thread &rarr;</a></p>';
    await emailEach(emails, 'New comment on: ' + (post.title || 'a thread'), function (email) { return body + prefsFooter(email); });
  } catch (e) { console.log('notifyNewComment error:', e && e.message); }
}

// A scheduled post just went live -> tell its AUTHOR (in-app + push). notifyNewPost
// deliberately excludes the author from the fan-out (you don't notify yourself of
// your own post), so without this a scheduled post would publish with the author
// getting no signal it fired. That's the "I got no notification my posts posted
// this morning" gap: the author schedules it, walks away, and wants confirmation
// it actually went out. Type 'published' is folded into the Posts bell bucket in
// notifications.js so it increments the badge like any other notification.
async function notifyAuthorPostPublished(post, authorId) {
  try {
    if (!post || !post.id || !authorId) return;
    try {
      await sb('member_notifications', 'POST', [{
        user_id: authorId, type: 'published', actor_id: authorId,
        actor_name: 'Your scheduled post', title: post.title || '', post_id: post.id
      }], 'return=minimal');
    } catch (e) { console.log('notify author in-app:', e && e.message); }
    // Push to the author's own devices. Unconditional: this is a confirmation the
    // author asked for, not a broadcast, so it ignores the post-notification pref.
    try {
      await sendToAccounts([authorId], {
        title: 'Your scheduled post is live',
        body: post.title || 'Your post was published',
        url: PLATFORM_BASE + '?post=' + encodeURIComponent(post.id),
        tag: 'published-' + post.id
      });
    } catch (e) { console.log('notify author push:', e && e.message); }
  } catch (e) { console.log('notifyAuthorPostPublished error:', e && e.message); }
}

module.exports = { notifyNewPost, notifyNewComment, notifyAuthorPostPublished, emailBcc, emailEach, prefsFooter, sb };

// netlify/functions/_lib/notify.js
//
// Shared notification pipeline used by the post/comment/DM hooks. Every event
// creates IN-APP notification rows (member_notifications) and, per each member's
// email preference, sends a best-effort email. Nothing here throws or blocks the
// caller — a notification failure must never break posting/commenting/messaging.
//
// Member = accounts with tier 'forum' or 'full' (the tiers that can read posts).

const MEMBER_TIERS = "tier=in.(forum,full)";

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
    const recips = await sb('accounts?' + MEMBER_TIERS + '&id=neq.' + actorId + '&select=id,email,notify_email_posts', 'GET');
    if (!recips || !recips.length) return;

    const rows = recips.map(function (r) {
      return { user_id: r.id, type: 'post', actor_id: actorId, actor_name: actorName, title: post.title || 'New post', post_id: post.id };
    });
    try { await sb('member_notifications', 'POST', rows, 'return=minimal'); } catch (e) { console.log('notify post in-app:', e && e.message); }

    if (opts && opts.emailBlast) {
      const emails = recips.filter(function (r) { return r.notify_email_posts; }).map(function (r) { return r.email; });
      const body = '<p><strong>' + esc(actorName) + '</strong> posted on Think Beyond Practice:</p>' +
        '<p style="font-size:16px"><strong>' + esc(post.title || '') + '</strong></p>' +
        '<p><a href="' + PLATFORM_URL + '">Read it on the platform &rarr;</a></p>';
      await emailEach(emails, 'New post: ' + (post.title || 'Think Beyond Practice'), function (email) { return body + prefsFooter(email); });
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
    delete idset[commenterId];
    const ids = Object.keys(idset);
    if (!ids.length) return;

    const recips = await sb('accounts?id=in.(' + ids.join(',') + ')&select=id,email,notify_email_comments', 'GET');
    if (!recips || !recips.length) return;

    const rows = recips.map(function (r) {
      return { user_id: r.id, type: 'comment', actor_id: commenterId || null, actor_name: commenterName, title: post.title || 'a post', post_id: post.id };
    });
    try { await sb('member_notifications', 'POST', rows, 'return=minimal'); } catch (e) { console.log('notify comment in-app:', e && e.message); }

    const emails = recips.filter(function (r) { return r.notify_email_comments; }).map(function (r) { return r.email; });
    const body = '<p><strong>' + esc(commenterName) + '</strong> commented on a thread you\'re part of:</p>' +
      '<p style="font-size:16px"><strong>' + esc(post.title || '') + '</strong></p>' +
      '<p><a href="' + PLATFORM_URL + '">Read the thread &rarr;</a></p>';
    await emailEach(emails, 'New comment on: ' + (post.title || 'a thread'), function (email) { return body + prefsFooter(email); });
  } catch (e) { console.log('notifyNewComment error:', e && e.message); }
}

module.exports = { notifyNewPost, notifyNewComment, emailBcc, emailEach, prefsFooter, sb };

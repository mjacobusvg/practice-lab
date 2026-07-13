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

// Best-effort email to many recipients via SES, hidden via Bcc, chunked.
async function emailBcc(toEmails, subject, html) {
  try {
    const list = (toEmails || []).filter(function (e) { return e && String(e).indexOf('@') !== -1; });
    if (!list.length) return;
    const region = process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
    const accessKeyId = process.env.SES_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) return;
    const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
    const client = new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } });
    const from = process.env.SES_FROM || 'Think Beyond Practice <noreply@thinkbeyondpractice.com>';
    const to = process.env.NOTIFY_TO || 'noreply@thinkbeyondpractice.com';
    for (let i = 0; i < list.length; i += 45) {
      const chunk = list.slice(i, i + 45);
      await client.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to], BccAddresses: chunk },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Html: { Data: html, Charset: 'UTF-8' } } } }
      }));
    }
  } catch (e) { console.log('notify email error:', e && e.message); }
}

const PLATFORM_URL = 'https://thinkbeyondpractice.com/platform.html';

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
      const html = '<p><strong>' + esc(actorName) + '</strong> posted on Think Beyond Practice:</p>' +
        '<p style="font-size:16px"><strong>' + esc(post.title || '') + '</strong></p>' +
        '<p><a href="' + PLATFORM_URL + '">Read it on the platform &rarr;</a></p>' +
        '<p style="font-size:12px;color:#888">Manage email notifications in your profile.</p>';
      await emailBcc(emails, 'New post: ' + (post.title || 'Think Beyond Practice'), html);
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
    const html = '<p><strong>' + esc(commenterName) + '</strong> commented on a thread you\'re part of:</p>' +
      '<p style="font-size:16px"><strong>' + esc(post.title || '') + '</strong></p>' +
      '<p><a href="' + PLATFORM_URL + '">Read the thread &rarr;</a></p>' +
      '<p style="font-size:12px;color:#888">Manage email notifications in your profile.</p>';
    await emailBcc(emails, 'New comment on: ' + (post.title || 'a thread'), html);
  } catch (e) { console.log('notifyNewComment error:', e && e.message); }
}

module.exports = { notifyNewPost, notifyNewComment, emailBcc, sb };

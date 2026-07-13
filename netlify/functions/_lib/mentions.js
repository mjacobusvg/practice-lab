// netlify/functions/_lib/mentions.js
//
// @mentions for posts, comments, and DMs. The composer sends the display body
// plus mention_ids (account ids the member picked from the autocomplete). Here we:
//   1. resolve those ids to real member accounts (never trust a client-supplied
//      name; we look the account up and use its stored name),
//   2. linkify occurrences of "@<name>" in the already-escaped body HTML into a
//      styled, clickable mention chip, and
//   3. create in-app notifications (+ opt-in email) for the mentioned members.
//
// Nothing here throws to the caller: a mention failure must never block the
// post/comment/message from being created.

const { sb, emailBcc } = require('./notify');

const PLATFORM_URL = 'https://thinkbeyondpractice.com/platform.html';
const MAX_MENTIONS = 20;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function reEsc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A conservative uuid check so we never build a filter from junk.
function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
}

// Resolve client-supplied mention ids to real members (tier forum/full). Returns
// [{ id, name, email, notify_email_comments }]. Unknown/non-member ids drop out.
async function resolveMentions(mentionIds) {
  try {
    const ids = (Array.isArray(mentionIds) ? mentionIds : [])
      .map(function (x) { return String(x || '').trim(); })
      .filter(isUuid);
    const uniq = ids.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, MAX_MENTIONS);
    if (!uniq.length) return [];
    const rows = await sb('accounts?id=in.(' + uniq.join(',') + ')&tier=in.(forum,full)&select=id,name,email,notify_email_comments', 'GET');
    return rows || [];
  } catch (e) { return []; }
}

// Wrap "@<name>" (name escaped the same way the body was) in a mention chip.
// Longest names first so "@Ann Marie" wins over "@Ann". Operates on toHtml output.
function linkifyMentions(html, accounts) {
  let out = String(html || '');
  const list = (accounts || []).filter(function (a) { return a && a.id && a.name; })
    .slice().sort(function (a, b) { return b.name.length - a.name.length; });
  list.forEach(function (a) {
    const nameEsc = esc(a.name);
    const re = new RegExp('@' + reEsc(nameEsc), 'g');
    out = out.replace(re, '<span class="mention" onclick="viewProfile(\'' + a.id + '\')">@' + nameEsc + '</span>');
  });
  return out;
}

// In-app notification (+ opt-in email) for each mentioned member, minus the actor.
// ctx: { title, post_id }  (post_id may be null for DMs).
async function notifyMentions(accounts, actor, ctx) {
  try {
    const actorId = (actor && actor.id) || null;
    const actorName = (actor && actor.name) || 'A member';
    const recips = (accounts || []).filter(function (a) { return a && a.id && a.id !== actorId; });
    if (!recips.length) return;

    const title = (ctx && ctx.title) || 'mentioned you';
    const postId = (ctx && ctx.post_id) || null;
    const rows = recips.map(function (a) {
      return { user_id: a.id, type: 'mention', actor_id: actorId, actor_name: actorName, title: title, post_id: postId };
    });
    try { await sb('member_notifications', 'POST', rows, 'return=minimal'); } catch (e) { console.log('notify mention in-app:', e && e.message); }

    const emails = recips.filter(function (a) { return a.notify_email_comments && a.email; }).map(function (a) { return a.email; });
    const html = '<p><strong>' + esc(actorName) + '</strong> mentioned you on Think Beyond Practice' +
      (ctx && ctx.title ? ': <strong>' + esc(ctx.title) + '</strong>' : '') + '.</p>' +
      '<p><a href="' + PLATFORM_URL + '">Open the platform &rarr;</a></p>' +
      '<p style="font-size:12px;color:#888">Manage email notifications in your profile.</p>';
    await emailBcc(emails, esc(actorName) + ' mentioned you', html);
  } catch (e) { console.log('notifyMentions error:', e && e.message); }
}

module.exports = { resolveMentions, linkifyMentions, notifyMentions };

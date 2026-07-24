// netlify/functions/sunday-broadcast-prep.js
//
// Restarts Michael's "Sunday paid-member broadcast" ritual on our own platform
// (replaces the one he ran from Circle). It does NOT email members. Every Sunday
// morning it:
//   1) pulls the posts published in the last 7 days,
//   2) drafts a ready-to-send paid-member broadcast featuring the two newest, and
//   3) emails that draft to MICHAEL so he can eyeball it, swap posts if he wants,
//      and send it to paying members from the broadcast composer (audience: Members).
//
// Nothing goes to members automatically — the human stays in the loop. If there
// were no new posts this week, it sends Michael a short nudge instead (a useful
// signal, given content cadence has been slowing).
//
// Trigger: netlify.toml scheduled function (Sunday), or manual POST { secret }.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SES_*, BACKFILL_SECRET

const SITE = 'https://thinkbeyondpractice.com';
const ADMIN_TO = 'michael@thinkbeyondpractice.com';

function postLink(id) { return SITE + '/platform.html?post=' + encodeURIComponent(id); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The ready-to-send broadcast body (markdown), featuring up to two posts. This is
// what Michael pastes into the composer. Kept in his voice: short, personal, drives
// to the platform rather than reproducing the posts.
function draftMarkdown(featured) {
  const lines = [];
  lines.push("Happy Sunday —");
  lines.push("");
  lines.push("Here's what's new in the community this week. Two worth your time:");
  lines.push("");
  featured.forEach(function (p, i) {
    lines.push('**' + (i + 1) + '. [' + (p.title || 'Untitled') + '](' + postLink(p.id) + ')**');
    if (p.excerpt) lines.push(p.excerpt.trim());
    lines.push('');
  });
  lines.push("Jump in, add your take in the comments, and I'll see you in there.");
  lines.push("");
  lines.push("Michael");
  return lines.join('\n');
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const scheduled = !!(p && p.next_run);
  const secretOk = process.env.BACKFILL_SECRET && p.secret === process.env.BACKFILL_SECRET;
  if (!scheduled && !secretOk) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  const sb = async (path) => {
    const res = await fetch(URL + '/rest/v1/' + path, { headers: auth });
    const t = await res.text();
    if (!res.ok) throw new Error('sb ' + res.status + ': ' + t.slice(0, 150));
    return t ? JSON.parse(t) : null;
  };

  let ses = null;
  const accessKeyId = process.env.SES_AWS_ACCESS_KEY_ID || process.env.SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.SES_AWS_SECRET_ACCESS_KEY || process.env.SES_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    const region = process.env.SES_AWS_REGION || process.env.SES_REGION || 'us-east-1';
    const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
    ses = { client: new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } }), SendEmailCommand, from: process.env.SES_FROM || 'Michael Van Gelder <michael@thinkbeyondpractice.com>' };
  }
  if (!ses) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'SES not configured' }) };

  try {
    // Posts from the last 7 days, newest first. Exclude pinned announcements so the
    // feature picks real content; Michael can still swap in anything from the list.
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const posts = await sb('forum_posts?created_at=gte.' + encodeURIComponent(since) +
      '&is_pinned=is.false&select=id,title,excerpt,created_at,comment_count&order=created_at.desc&limit=25');

    const featured = (posts || []).slice(0, 2);
    const md = featured.length ? draftMarkdown(featured) : '';

    // Build Michael's prep email.
    let inner = '<div style="max-width:640px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222">';

    if (!featured.length) {
      inner += '<p><strong>No new posts were logged in the community this week.</strong></p>' +
        '<p>Nothing to announce in the Sunday paid-member broadcast — unless you want to write one before you send. The ritual only lands if there\'s something there.</p>' +
        '<p><a href="' + SITE + '/platform.html">Open the platform &rarr;</a></p>';
    } else {
      inner += '<p><strong>Your Sunday paid-member broadcast is ready to review.</strong> Copy the draft below into the broadcast composer (audience: <strong>Members</strong>), tweak anything, and send. Swap in different posts from the full week\'s list underneath if you\'d rather feature others.</p>';

      inner += '<div style="border:1px solid #d9dde2;border-radius:8px;padding:16px 18px;margin:18px 0;background:#f7f9fa">';
      inner += '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#77808a;margin-bottom:8px">Ready-to-send draft &mdash; subject line</div>';
      inner += '<div style="font-weight:700;margin-bottom:14px">This week in the community: 2 posts worth your time</div>';
      inner += '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#77808a;margin-bottom:8px">Body (paste as-is)</div>';
      inner += '<pre style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:14px;margin:0;color:#222">' + esc(md) + '</pre>';
      inner += '</div>';

      inner += '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#77808a;margin:22px 0 8px">All posts this week (' + posts.length + ') &mdash; swap any in</div>';
      inner += '<ul style="padding-left:18px;margin:0">';
      posts.forEach(function (pp) {
        inner += '<li style="margin-bottom:8px"><a href="' + postLink(pp.id) + '">' + esc(pp.title || 'Untitled') + '</a>' +
          '<span style="color:#77808a"> &middot; ' + (pp.comment_count || 0) + ' comments</span></li>';
      });
      inner += '</ul>';
    }

    inner += '<p style="color:#77808a;font-size:12px;margin-top:24px">Automated Sunday prep &middot; this email goes only to you &middot; nothing was sent to members.</p>';
    inner += '</div>';

    await ses.client.send(new ses.SendEmailCommand({
      FromEmailAddress: ses.from,
      Destination: { ToAddresses: [ADMIN_TO] },
      ReplyToAddresses: [ADMIN_TO],
      Content: { Simple: { Subject: { Data: (featured.length ? '📋 Sunday broadcast ready to send' : '📋 Sunday broadcast — no new posts this week'), Charset: 'UTF-8' }, Body: { Html: { Data: inner, Charset: 'UTF-8' } } } }
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, week_posts: (posts || []).length, featured: featured.length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

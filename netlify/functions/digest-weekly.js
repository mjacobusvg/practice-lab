// netlify/functions/digest-weekly.js
// Weekly digest email: a roundup of the past week's most-discussed and newest
// threads, sent (Bcc) to members who opted into post-activity email
// (notify_email_posts). Scheduled via netlify.toml ([[scheduled_functions]]).
//
// Guardrails so a stray manual hit can't spam members:
//   - Only sends if invoked by the Netlify scheduler (body carries next_run) OR
//     with the DIGEST_SECRET header (for a deliberate manual run).
//   - Refuses to send twice within 3 days (digest_sends log).
//   - Sends nothing if there were no new posts in the window.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SES_* (via _lib/notify), DIGEST_SECRET (optional)

const { emailBcc } = require('./_lib/notify');

const PLATFORM_URL = 'https://thinkbeyondpractice.com/platform.html';
const WINDOW_DAYS = 7;
const MIN_GAP_DAYS = 3;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const sb = async (path, method, body, prefer) => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, auth);
    if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 150));
    return text ? JSON.parse(text) : null;
  };

  // Authorize: Netlify scheduler (body has next_run) or the manual secret.
  let scheduled = false;
  try { const b = JSON.parse(event.body || '{}'); if (b && b.next_run) scheduled = true; } catch (e) {}
  const secret = (event.headers['x-digest-secret'] || event.headers['X-Digest-Secret'] || '').trim();
  const secretOk = process.env.DIGEST_SECRET && secret && secret === process.env.DIGEST_SECRET;
  if (!scheduled && !secretOk) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  try {
    // Don't send twice in a short window (double-fire or manual + scheduled).
    const recent = await sb('digest_sends?order=sent_at.desc&limit=1&select=sent_at', 'GET');
    if (recent && recent.length) {
      const last = new Date(recent[0].sent_at).getTime();
      if (Date.now() - last < MIN_GAP_DAYS * 24 * 60 * 60 * 1000) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'sent recently' }) };
      }
    }

    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const sinceEnc = encodeURIComponent(since);

    // Most-discussed first, then newest; a small curated set for the email.
    const posts = await sb('forum_posts?created_at=gt.' + sinceEnc + '&order=comment_count.desc,created_at.desc&limit=8&select=id,title,excerpt,comment_count,created_at,spaces(name)', 'GET');
    if (!posts || !posts.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'no new posts' }) };
    }

    const recips = await sb('accounts?tier=in.(forum,full)&notify_email_posts=is.true&select=email', 'GET');
    const emails = (recips || []).map(function (r) { return r.email; }).filter(function (e) { return e && e.indexOf('@') !== -1; });
    if (!emails.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'no opted-in recipients' }) };
    }

    let list = '';
    posts.forEach(function (p) {
      const sp = p.spaces ? p.spaces.name : '';
      const c = Number(p.comment_count) || 0;
      list += '<li style="margin-bottom:14px">' +
        '<a href="' + PLATFORM_URL + '" style="font-size:15px;font-weight:600;color:#0b7285;text-decoration:none">' + esc(p.title || 'Untitled') + '</a>' +
        '<div style="font-size:12px;color:#888;margin-top:2px">' + (sp ? esc(sp) + ' &middot; ' : '') + c + ' comment' + (c === 1 ? '' : 's') + '</div>' +
        (p.excerpt ? '<div style="font-size:13px;color:#444;margin-top:4px">' + esc(String(p.excerpt).slice(0, 160)) + '</div>' : '') +
        '</li>';
    });

    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto">' +
      '<p style="font-size:16px"><strong>This week on Think Beyond Practice</strong></p>' +
      '<p style="font-size:13px;color:#555">The threads your peers have been discussing over the last ' + WINDOW_DAYS + ' days.</p>' +
      '<ul style="padding-left:18px;margin:16px 0">' + list + '</ul>' +
      '<p><a href="' + PLATFORM_URL + '" style="display:inline-block;background:#0b7285;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px">Open the platform &rarr;</a></p>' +
      '<p style="font-size:12px;color:#999;margin-top:20px">You are receiving this because post notifications are on in your profile. Turn them off any time in your profile settings.</p>' +
      '</div>';

    await emailBcc(emails, 'This week on Think Beyond Practice', html);
    try { await sb('digest_sends', 'POST', { recipient_count: emails.length, post_count: posts.length }, 'return=minimal'); } catch (e) {}

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, recipients: emails.length, posts: posts.length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

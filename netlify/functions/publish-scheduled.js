// netlify/functions/publish-scheduled.js
// Cron worker (netlify.toml scheduled_functions) that publishes any scheduled
// announcement/post whose time has come, then notifies members (in-app always;
// email blast per the row's email_blast flag, like a Michael post). Idempotent:
// only rows still in 'scheduled' status are published, and each is flipped to
// 'published' before notifying so a re-fire can't double-post.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (+ SES via notify), optional PUBLISH_SECRET

const { toRichHtml } = require('./_lib/richtext');
const { notifyNewPost } = require('./_lib/notify');

const MICHAEL_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json' };
  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  const sb = async (path, method, body, prefer) => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, auth);
    if (prefer) h['Prefer'] = prefer;
    const res = await fetch(URL + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 150));
    return text ? JSON.parse(text) : null;
  };

  // Allow the Netlify scheduler (body carries next_run) or a manual secret.
  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const scheduled = !!(p && p.next_run);
  const secret = (event.headers['x-publish-secret'] || event.headers['X-Publish-Secret'] || '').trim();
  const secretOk = (process.env.PUBLISH_SECRET && secret === process.env.PUBLISH_SECRET) ||
    (process.env.BACKFILL_SECRET && p.secret === process.env.BACKFILL_SECRET);
  if (!scheduled && !secretOk) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  try {
    const nowIso = new Date().toISOString();
    const due = await sb('scheduled_posts?status=eq.scheduled&publish_at=lte.' + encodeURIComponent(nowIso) + '&order=publish_at.asc&limit=25&select=*', 'GET');
    if (!due || !due.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, published: 0 }) };

    let published = 0;
    for (let i = 0; i < due.length; i++) {
      const s = due[i];
      // Claim it first (scheduled -> published) so a concurrent/re-fire can't double-post.
      const claim = await sb('scheduled_posts?id=eq.' + s.id + '&status=eq.scheduled', 'PATCH', { status: 'published' }, 'return=representation');
      if (!claim || !claim.length) continue; // someone else claimed it

      try {
        const spaces = await sb('spaces?slug=eq.' + encodeURIComponent(s.space) + '&select=id&limit=1', 'GET');
        if (!spaces || !spaces.length) throw new Error('Space not found: ' + s.space);
        const excerpt = String(s.body).replace(/\s+/g, ' ').slice(0, 200);
        const row = {
          space_id: spaces[0].id,
          author_id: MICHAEL_ACCOUNT_ID,
          title: s.title,
          body_plain: s.body,
          body_html: toRichHtml(s.body),
          excerpt: excerpt,
          comment_count: 0,
          reaction_count: 0,
          post_type: 'discussion',
          is_pinned: !!s.pin,
          free_visible: !!s.free_visible
        };
        // Optional: publish under a pre-chosen id so a link can be handed out
        // (e.g. in an email) before the post goes live. Only when explicitly set.
        if (s.forced_post_id) row.id = s.forced_post_id;
        const inserted = await sb('forum_posts', 'POST', row, 'return=representation');
        const postId = inserted && inserted[0] && inserted[0].id;
        await sb('scheduled_posts?id=eq.' + s.id, 'PATCH', { published_post_id: postId, error: null }, 'return=minimal');

        try {
          await notifyNewPost(
            { id: postId, title: s.title, author_id: MICHAEL_ACCOUNT_ID },
            { id: MICHAEL_ACCOUNT_ID, name: 'Michael Van Gelder' },
            { emailBlast: s.email_blast !== false }
          );
        } catch (e) { /* never fail the publish on a notify error */ }
        published++;
      } catch (e) {
        // Roll the claim back to an error state so it doesn't silently vanish.
        await sb('scheduled_posts?id=eq.' + s.id, 'PATCH', { status: 'error', error: String(e.message || e).slice(0, 300) }, 'return=minimal');
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, published: published, due: due.length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

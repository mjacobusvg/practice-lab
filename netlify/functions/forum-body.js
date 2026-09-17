// netlify/functions/forum-body.js
//
// Serves the BODY of a forum post (and its comments) only to a caller entitled to read
// it. Security audit 2026-09-17.
//
// WHAT WAS WRONG
// forum_posts and forum_comments carry `Public read … [SELECT to {public} using true]`,
// platform.html:3857 selected body_html/body_plain for any post, and the browser then
// decided whether to paint it:
//
//     if (!isPaidMember() && !post.free_visible && !unlocked) { …show teaser… }
//
// So the paywall lived in JavaScript. Measured against production on 2026-09-17: 554 of
// 578 posts are member-only, and every one of their bodies — plus 2,565 comments — came
// back to the publishable anon key, the same key printed in platform.html:2262. Both the
// paid tier and the members' expectation of a closed room rested on the client choosing
// not to render bytes it had already been handed.
//
// THE RULE, UNCHANGED
// This endpoint encodes exactly what the client used to decide, so nobody's access
// changes — only where the decision is made:
//
//   free_visible post            -> anyone, signed in or not, reads it in full
//   paid member (forum | full)   -> reads everything
//   free member who UNLOCKED it  -> reads that one post (the one-per-month meter in
//                                   post-unlock.js; a recorded unlock keeps the post open)
//   everyone else                -> no body. The client already holds `excerpt` and
//                                   renders its existing teaser + join gate from that.
//
// Privilege is `scope === 'member'`, which platform-auth.js mints only for tier forum or
// full ('free' accounts get scope 'free'), matching post-unlock.js.
//
// The members-only SECOND half (post_members_extra / members_teaser) is NOT served here.
// It was already gated correctly by post-unlock.js and was never sent to a non-member.
//
// Body: { post_id, token? } -> { ok, entitled, body_html?, body_plain?, comments? }
// A refusal is a 200 with entitled:false, not a 403: not being entitled is the normal
// state for a logged-out reader, and the client renders the teaser from it.
//
// THE DATABASE SIDE, APPLIED 2026-09-17 — recorded here because a grant is invisible
// state that lives in no file otherwise. A table-level SELECT grant covers every column,
// so revoking one column is a no-op; the table grant has to go and the wanted columns be
// granted back:
//
//   revoke select on public.forum_posts from anon, authenticated;
//   grant  select (<every column except body_html, body_plain>) on public.forum_posts
//     to anon, authenticated;
//   -- and the same for public.forum_comments
//
// Verified after applying: `select=id,title,body_plain` and `select=*` both answer
// 401 permission denied, while `select=id,title,excerpt,free_visible,members_teaser,
// comment_count` still answers 206 with all 578 rows — so feeds, search, space listings
// and the teaser keep working untouched. Every remaining client query was checked to be
// metadata-only first.
//
// `canonical_synthesis` rides along for the same reason: the UI shows it only after the
// teaser gate, so it is members-only content, and it was readable straight off the table.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SIGNING_SECRET

const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Server misconfigured' }) };

  let p = {};
  try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const postId = String(p.post_id || '').trim();
  if (!postId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'post_id required' }) };

  function sb(path) {
    return fetch(URL + '/rest/v1/' + path, {
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }
    }).then(function (r) { return r.ok ? r.json() : []; });
  }

  // Not entitled is an ordinary outcome, so it carries the reason for debugging and
  // nothing else. No body field is present at all, rather than an empty one, so a
  // client bug cannot render a blank post and look like the content was lost.
  function deny(reason) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, entitled: false, reason: reason }) };
  }

  try {
    const postRows = await sb('forum_posts?id=eq.' + encodeURIComponent(postId) +
      '&select=id,free_visible,body_html,body_plain,canonical_synthesis&limit=1');
    const post = postRows && postRows[0];
    if (!post) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Post not found' }) };

    let entitled = post.free_visible === true;
    let via = entitled ? 'free_visible' : null;

    if (!entitled) {
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
      const session = token ? verifyToken(token) : { valid: false };

      if (session.valid) {
        const email = String(session.claims.email || '').toLowerCase().trim();
        const scope = session.claims.scope;

        if (scope === 'member' || ADMIN_EMAILS.indexOf(email) !== -1) {
          entitled = true; via = 'paid';
        } else if (email) {
          // A free member keeps whatever they spent an unlock on. Resolve the account
          // from the TOKEN's email, never from the request body.
          const me = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id&limit=1');
          if (me && me[0]) {
            const unlocked = await sb('post_unlocks?account_id=eq.' + encodeURIComponent(me[0].id) +
              '&post_id=eq.' + encodeURIComponent(postId) + '&select=id&limit=1');
            if (unlocked && unlocked.length) { entitled = true; via = 'unlocked'; }
          }
        }
      }
    }

    if (!entitled) return deny('not_entitled');

    // Comments ride on the post's entitlement: the old client returned before rendering
    // any comment when the post was gated, so this changes nothing about who reads them.
    const comments = await sb('forum_comments?post_id=eq.' + encodeURIComponent(postId) +
      '&select=id,body_html,body_plain&order=created_at.asc&limit=500');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        entitled: true,
        via: via,
        body_html: post.body_html,
        body_plain: post.body_plain,
        // Rendered at platform.html:4122, i.e. AFTER the teaser gate returns, so it was
        // always members-only in the UI while being readable straight off the table.
        canonical_synthesis: post.canonical_synthesis,
        comments: comments || []
      })
    };
  } catch (err) {
    console.error('forum-body failed:', err && err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Lookup failed' }) };
  }
};

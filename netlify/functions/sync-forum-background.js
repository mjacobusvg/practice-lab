// netlify/functions/sync-forum-background.js  (background function)
//
// Syncs Circle posts + comments into the MEMBER-FACING display tables
// (forum_posts / forum_comments) that platform.html renders. This is what keeps
// the platform forum current. It is SEPARATE from circle-weekly-sync-background.js,
// which feeds the Ask-the-Archive `posts` embeddings table (unrelated to display).
//
// Dedup by circle_post_id / circle_comment_id (upsert). Authors are resolved to an
// account by email; a missing author gets a minimal FREE account created so their
// name/photo render on their posts.
//
// Modes (POST with BACKFILL_SECRET; scheduled runs behave as incremental):
//   { secret }               incremental: only posts newer than newest forum_posts
//   { secret, full:true }    full backfill: walk every post in every mapped space
//   { secret, full:true, space:'quick-q' }  restrict a full run to one space
//
// Idempotent and time-bounded: if it approaches the function timeout it stops and
// returns { incomplete:true }; just run it again to continue.
//
// Env: CIRCLE_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKFILL_SECRET

const CIRCLE = 'https://app.circle.so/api/v1';
const TIME_BUDGET_MS = 820 * 1000; // stop before the 900s background limit

// Platform space slugs NOT synced from Circle (sims, paid toolkit, nav, tool).
const EXCLUDE_SLUGS = ['billing-sim', 'practice-sim', 'therapy-sim', 'toolkit', 'your-platform'];

exports.handler = async function (event) {
  const start = Date.now();
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event && event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  let opts = {};
  if (event && event.httpMethod === 'POST') {
    try { opts = JSON.parse(event.body || '{}'); } catch (e) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    if (opts.secret !== process.env.BACKFILL_SECRET) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  const CIRCLE_TOKEN = process.env.CIRCLE_API_TOKEN;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!CIRCLE_TOKEN || !SB_URL || !SB_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  const circle = (path) => fetch(CIRCLE + path, { headers: { Authorization: 'Token ' + CIRCLE_TOKEN, 'Content-Type': 'application/json' } });
  const sbHeaders = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
  const sbGet = async (path) => { const r = await fetch(SB_URL + '/rest/v1/' + path, { headers: sbHeaders }); return r.ok ? r.json() : []; };
  const sbWrite = (path, method, body, prefer) => fetch(SB_URL + '/rest/v1/' + path, {
    method, headers: Object.assign({}, sbHeaders, prefer ? { Prefer: prefer } : {}), body: JSON.stringify(body)
  });

  const stats = { spaces: 0, posts: 0, comments: 0, accounts_created: 0, errors: [], incomplete: false };

  try {
    // ── Space map: circle_space_id -> platform space uuid ──────────────────────
    const spaceRows = await sbGet('spaces?select=id,slug,circle_space_id&circle_space_id=not.is.null');
    const spaceByCid = {};
    for (const s of spaceRows) {
      if (EXCLUDE_SLUGS.indexOf(s.slug) !== -1) continue;
      if (opts.space && s.slug !== opts.space) continue;
      spaceByCid[String(s.circle_space_id)] = s.id;
    }

    // ── Account cache: email -> id (paged) ─────────────────────────────────────
    const emailToId = new Map();
    for (let off = 0; ; off += 1000) {
      const batch = await sbGet('accounts?select=id,email&limit=1000&offset=' + off);
      for (const a of batch) if (a.email) emailToId.set(a.email.toLowerCase().trim(), a.id);
      if (batch.length < 1000) break;
    }

    async function resolveAuthor(email, name, avatar) {
      const key = (email || '').toLowerCase().trim();
      if (!key) return null;
      if (emailToId.has(key)) return emailToId.get(key);
      // create a minimal free account for this previously-unseen author
      const res = await sbWrite('accounts', 'POST', { email: key, name: name || key, avatar_url: avatar || null, tier: 'free' }, 'return=representation');
      if (res.ok) {
        const rows = await res.json();
        if (rows[0]) { emailToId.set(key, rows[0].id); stats.accounts_created++; return rows[0].id; }
      } else if (res.status === 409) {
        // created concurrently / already exists: fetch it
        const rows = await sbGet('accounts?select=id&email=eq.' + encodeURIComponent(key) + '&limit=1');
        if (rows[0]) { emailToId.set(key, rows[0].id); return rows[0].id; }
      }
      return null;
    }

    // ── Incremental watermark (newest existing display post) ──────────────────
    let since = null;
    if (!opts.full) {
      const latest = await sbGet('forum_posts?select=created_at&order=created_at.desc&limit=1');
      since = latest.length ? new Date(latest[0].created_at) : null;
    }

    // ── Walk each mapped space ────────────────────────────────────────────────
    for (const cid of Object.keys(spaceByCid)) {
      if (Date.now() - start > TIME_BUDGET_MS) { stats.incomplete = true; break; }
      const spaceUuid = spaceByCid[cid];
      stats.spaces++;

      let page = 1, stop = false;
      while (!stop) {
        if (Date.now() - start > TIME_BUDGET_MS) { stats.incomplete = true; break; }
        const r = await circle('/posts?space_id=' + cid + '&page=' + page + '&per_page=30&sort=created_at&order=desc');
        if (!r.ok) { stats.errors.push('posts space ' + cid + ' p' + page + ': ' + r.status); break; }
        const data = await r.json();
        const batch = Array.isArray(data) ? data : (data.posts || data.records || []);
        if (!batch.length) break;

        for (const post of batch) {
          const created = new Date(post.created_at);
          if (since && created <= since) { stop = true; break; } // reached known territory

          try {
            const authorId = await resolveAuthor(post.user_email, post.user_name, post.user_avatar_url);
            const bodyHtml = extractHtml(post.body);
            const bodyPlain = stripHtml(bodyHtml);
            const title = (post.name && post.name.trim()) || deriveTitle(bodyPlain) || '(untitled)';
            const row = {
              space_id: spaceUuid,
              author_id: authorId,
              title: title,
              body_html: bodyHtml,
              body_plain: bodyPlain,
              excerpt: bodyPlain.replace(/\s+/g, ' ').slice(0, 200),
              comment_count: post.comments_count || 0,
              circle_post_id: post.id,
              post_type: 'discussion',
              created_at: post.created_at,
              updated_at: post.updated_at || post.created_at
            };
            // Preserve platform-side organization: for an EXISTING post, update its
            // content but NEVER overwrite space_id — it may have been re-filed on the
            // platform, and the platform is now the source of truth. Only a brand-new
            // post is placed into its Circle-derived space.
            const existing = await sbGet('forum_posts?circle_post_id=eq.' + encodeURIComponent(post.id) + '&select=id');
            let forumPostId;
            if (existing && existing[0]) {
              forumPostId = existing[0].id;
              const { space_id: _omitSpace, ...contentOnly } = row;
              const up = await sbWrite('forum_posts?id=eq.' + forumPostId, 'PATCH', contentOnly, 'return=minimal');
              if (!up.ok) { stats.errors.push('post ' + post.id + ': ' + up.status + ' ' + (await up.text()).slice(0, 120)); continue; }
            } else {
              const up = await sbWrite('forum_posts?on_conflict=circle_post_id', 'POST', row, 'resolution=merge-duplicates,return=representation');
              if (!up.ok) { stats.errors.push('post ' + post.id + ': ' + up.status + ' ' + (await up.text()).slice(0, 120)); continue; }
              const savedRows = await up.json();
              forumPostId = savedRows[0] && savedRows[0].id;
            }
            stats.posts++;

            // comments for this post
            if (forumPostId && (post.comments_count || 0) > 0) {
              let cpage = 1;
              const parentPairs = []; // [circle_child_id, circle_parent_id] for threaded replies
              while (true) {
                if (Date.now() - start > TIME_BUDGET_MS) { stats.incomplete = true; break; }
                const cr = await circle('/comments?post_id=' + post.id + '&page=' + cpage + '&per_page=50');
                if (!cr.ok) break;
                const cdata = await cr.json();
                const cbatch = Array.isArray(cdata) ? cdata : (cdata.comments || cdata.records || []);
                if (!cbatch.length) break;
                for (const c of cbatch) {
                  try {
                    const cAuthor = await resolveAuthor(c.user_email, c.user_name, c.user_avatar_url);
                    const cHtml = extractHtml(c.body);
                    const crow = {
                      post_id: forumPostId,
                      author_id: cAuthor,
                      body_html: cHtml,
                      body_plain: stripHtml(cHtml),
                      circle_comment_id: c.id,
                      created_at: c.created_at,
                      updated_at: c.updated_at || c.created_at
                    };
                    const cu = await sbWrite('forum_comments?on_conflict=circle_comment_id', 'POST', crow, 'resolution=merge-duplicates,return=minimal');
                    if (cu.ok) stats.comments++;
                    if (c.parent_comment_id) parentPairs.push([c.id, c.parent_comment_id]);
                  } catch (ce) { stats.errors.push('comment ' + c.id + ': ' + ce.message); }
                }
                if (cbatch.length < 50) break;
                cpage++;
              }
              // Resolve threaded replies: map each Circle parent id to our comment id
              // and set parent_comment_id so the renderer nests the reply. This runs
              // after all of the post's comments are upserted, so a parent on an
              // earlier page is already present. Best-effort — it never breaks a sync.
              if (parentPairs.length) {
                try {
                  const rows = await sbGet('forum_comments?post_id=eq.' + forumPostId + '&select=id,circle_comment_id');
                  const idByCircle = {};
                  for (const r of rows) { if (r.circle_comment_id != null) idByCircle[r.circle_comment_id] = r.id; }
                  for (const [childCircle, parentCircle] of parentPairs) {
                    const childId = idByCircle[childCircle], parentId = idByCircle[parentCircle];
                    if (childId && parentId) {
                      await sbWrite('forum_comments?id=eq.' + childId, 'PATCH', { parent_comment_id: parentId }, 'return=minimal');
                    }
                  }
                } catch (pe) { stats.errors.push('thread resolve post ' + post.id + ': ' + pe.message); }
              }
            }
          } catch (pe) { stats.errors.push('post ' + post.id + ': ' + pe.message); }
        }

        if (batch.length < 30) break;
        page++;
      }
    }
  } catch (e) {
    stats.errors.push('FATAL: ' + e.message);
  }

  stats.elapsed_s = Math.round((Date.now() - start) / 1000);
  stats.errors = stats.errors.slice(0, 25);
  return { statusCode: 200, headers: CORS, body: JSON.stringify(stats) };
};

// Circle body is usually { body: '<html>' }; sometimes a string. Return HTML.
function extractHtml(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && typeof body.body === 'string') return body.body;
  return '';
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// Untitled Circle posts (common in quick-question spaces): first sentence/80 chars.
function deriveTitle(plain) {
  if (!plain) return '';
  const firstSentence = plain.split(/(?<=[.!?])\s/)[0] || plain;
  const t = firstSentence.slice(0, 80).trim();
  return plain.length > t.length ? t + (t.endsWith('.') ? '' : '...') : t;
}

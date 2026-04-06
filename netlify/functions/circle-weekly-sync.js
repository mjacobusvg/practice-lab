// netlify/functions/circle-weekly-sync.js
// Scheduled function — runs every Friday at midnight Pacific (07:00 UTC Saturday)
// Fetches Circle posts/comments created since the most recent record in Supabase
// Embeds and upserts anything new. Excludes simulator/toolkit spaces.
//
// netlify.toml entry:
// [[scheduled_functions]]
//   name = "circle-weekly-sync"
//   schedule = "0 7 * * 6"

const EXCLUDED_SPACE_SLUGS = [
  'billing-coding-simulat',
  'billing-coding-simulator',
  'therapeutic-technique',
  'private-practice-simulat',
  'private-practice-simulator',
  'toolkit-download',
  'toolkit-download-setup',
];

exports.handler = async function(event, context) {
  const circleToken = process.env.CIRCLE_API_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!circleToken || !supabaseUrl || !supabaseKey || !openaiKey) {
    console.log('WEEKLY SYNC ERROR: Missing env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  const stats = { posts: 0, comments: 0, embedded: 0, skipped: 0, errors: [] };

  try {
    console.log('WEEKLY SYNC START: ' + new Date().toISOString());

    // ── Step 1: Find the most recent created_at in Supabase ──────────────────
    const latestResp = await fetch(
      supabaseUrl + '/rest/v1/posts?select=created_at&order=created_at.desc&limit=1',
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey
        }
      }
    );

    if (!latestResp.ok) {
      throw new Error('Failed to fetch latest timestamp from Supabase: ' + latestResp.status);
    }

    const latestData = await latestResp.json();
    const sinceDate = latestData.length > 0
      ? new Date(latestData[0].created_at)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // fallback: 7 days ago

    console.log('Syncing posts created after: ' + sinceDate.toISOString());

    // ── Step 2: Get all existing IDs from Supabase to avoid re-embedding ─────
    const existingIds = await getExistingIds(supabaseUrl, supabaseKey);
    console.log('Existing records in Supabase: ' + existingIds.size);

    // ── Step 3: Fetch and filter spaces ──────────────────────────────────────
    const spaces = await getAllSpaces(circleToken);
    const targetSpaces = spaces.filter(function(s) {
      var slug = (s.slug || '').toLowerCase();
      return !EXCLUDED_SPACE_SLUGS.some(function(ex) { return slug.includes(ex); });
    });

    console.log('Target spaces: ' + targetSpaces.length + ' of ' + spaces.length);

    // ── Step 4: Walk spaces, find new posts, embed and upsert ─────────────────
    for (var si = 0; si < targetSpaces.length; si++) {
      var space = targetSpaces[si];

      try {
        var posts = await getAllPostsInSpace(circleToken, space.id);

        // Filter to only posts created after sinceDate
        var newPosts = posts.filter(function(p) {
          return new Date(p.created_at) > sinceDate;
        });

        if (newPosts.length === 0) continue;

        console.log('SPACE: ' + space.name + ' — ' + newPosts.length + ' new post(s)');

        for (var pi = 0; pi < newPosts.length; pi++) {
          var post = newPosts[pi];

          try {
            var fullPost = await getPost(circleToken, post.id);
            if (!fullPost) continue;

            var postBody = extractBody(fullPost);
            if (!postBody || postBody.length < 20) continue;

            // Embed and upsert post if not already in Supabase
            var postKey = 'post_' + post.id;
            if (!existingIds.has(postKey)) {
              var postText = [fullPost.name || '', postBody].filter(Boolean).join('\n\n').trim();
              var embedding = await getEmbedding(postText, openaiKey);

              await upsertToSupabase(supabaseUrl, supabaseKey, {
                id: postKey,
                circle_post_id: post.id,
                title: fullPost.name || '',
                body: postBody.substring(0, 10000),
                author: fullPost.user_name || 'Member',
                space_name: space.name,
                space_slug: space.slug,
                url: fullPost.url || '',
                created_at: post.created_at,
                updated_at: post.updated_at,
                embedding: embedding,
                chunk_index: 0
              });

              stats.posts++;
              stats.embedded++;
              console.log('  POST SYNCED: ' + (fullPost.name || post.id));
            } else {
              stats.skipped++;
            }

            // Always check comments on new posts — comments may have been added
            // after the post was originally indexed
            var comments = await getPostComments(circleToken, post.id);
            for (var ci = 0; ci < comments.length; ci++) {
              var comment = comments[ci];

              try {
                var commentKey = 'comment_' + comment.id;
                if (existingIds.has(commentKey)) continue;

                var commentBody = extractCommentBody(comment);
                if (!commentBody || commentBody.length < 20) continue;

                var commentText = '[Comment on: ' + (fullPost.name || 'post') + ']\n\n' + commentBody;
                var commentEmbedding = await getEmbedding(commentText, openaiKey);

                await upsertToSupabase(supabaseUrl, supabaseKey, {
                  id: commentKey,
                  circle_post_id: post.id,
                  title: 'Comment on: ' + (fullPost.name || ''),
                  body: commentBody.substring(0, 10000),
                  author: comment.user_name || 'Member',
                  space_name: space.name,
                  space_slug: space.slug,
                  url: fullPost.url || '',
                  created_at: comment.created_at,
                  updated_at: comment.updated_at,
                  embedding: commentEmbedding,
                  chunk_index: 0
                });

                stats.comments++;
                stats.embedded++;
              } catch(ce) {
                console.log('  COMMENT ERROR ' + comment.id + ': ' + ce.message);
                stats.errors.push('comment_' + comment.id + ': ' + ce.message);
              }
            }

            await sleep(300);

          } catch(pe) {
            console.log('  POST ERROR ' + post.id + ': ' + pe.message);
            stats.errors.push('post_' + post.id + ': ' + pe.message);
          }
        }

      } catch(se) {
        console.log('SPACE ERROR ' + space.name + ': ' + se.message);
        stats.errors.push('space_' + space.id + ': ' + se.message);
      }
    }

    console.log(
      'WEEKLY SYNC COMPLETE: posts=' + stats.posts +
      ' comments=' + stats.comments +
      ' embedded=' + stats.embedded +
      ' skipped=' + stats.skipped +
      ' errors=' + stats.errors.length
    );

  } catch(e) {
    console.log('WEEKLY SYNC FATAL: ' + e.message);
  }

  return {
    statusCode: 200,
    body: JSON.stringify(stats)
  };
};

// ── Fetch all existing record IDs from Supabase ───────────────────────────────
// Paginates through all records to build a complete set for dedup checking

async function getExistingIds(supabaseUrl, supabaseKey) {
  var ids = new Set();
  var offset = 0;
  var limit = 1000;

  while (true) {
    var resp = await fetch(
      supabaseUrl + '/rest/v1/posts?select=id&limit=' + limit + '&offset=' + offset,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey
        }
      }
    );
    if (!resp.ok) break;
    var data = await resp.json();
    if (!data.length) break;
    data.forEach(function(r) { ids.add(r.id); });
    if (data.length < limit) break;
    offset += limit;
  }

  return ids;
}

// ── Circle API helpers (identical to backfill) ────────────────────────────────

async function getAllSpaces(token) {
  var spaces = [];
  var page = 1;
  while (true) {
    var resp = await fetch('https://app.circle.so/api/v1/spaces?page=' + page + '&per_page=50', {
      headers: { 'Authorization': 'Token ' + token, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) { console.log('Spaces fetch failed: ' + resp.status); break; }
    var data = await resp.json();
    var batch = Array.isArray(data) ? data : (data.spaces || data.records || []);
    if (!batch.length) break;
    spaces = spaces.concat(batch);
    if (batch.length < 50) break;
    page++;
  }
  return spaces;
}

async function getAllPostsInSpace(token, spaceId) {
  var posts = [];
  var page = 1;
  while (true) {
    var resp = await fetch('https://app.circle.so/api/v1/posts?space_id=' + spaceId + '&page=' + page + '&per_page=50&sort=created_at&order=desc', {
      headers: { 'Authorization': 'Token ' + token, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) break;
    var data = await resp.json();
    var batch = Array.isArray(data) ? data : (data.posts || data.records || []);
    if (!batch.length) break;
    posts = posts.concat(batch);
    // Stop paginating once we've passed sinceDate — all older posts are already indexed
    var lastPost = batch[batch.length - 1];
    if (batch.length < 50) break;
    page++;
  }
  return posts;
}

async function getPost(token, postId) {
  var resp = await fetch('https://app.circle.so/api/v1/posts/' + postId, {
    headers: { 'Authorization': 'Token ' + token, 'Content-Type': 'application/json' }
  });
  if (!resp.ok) return null;
  return await resp.json();
}

async function getPostComments(token, postId) {
  var comments = [];
  var page = 1;
  while (true) {
    var resp = await fetch('https://app.circle.so/api/v1/comments?post_id=' + postId + '&page=' + page + '&per_page=50', {
      headers: { 'Authorization': 'Token ' + token, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) break;
    var data = await resp.json();
    var batch = Array.isArray(data) ? data : (data.comments || data.records || []);
    if (!batch.length) break;
    comments = comments.concat(batch);
    if (batch.length < 50) break;
    page++;
  }
  return comments;
}

function extractBody(post) {
  if (post.body && typeof post.body === 'object' && post.body.body) {
    return stripHtml(post.body.body);
  }
  if (typeof post.body === 'string') return stripHtml(post.body);
  if (post.body_plain_text) return post.body_plain_text;
  if (post.body_plain) return post.body_plain;
  return '';
}

function extractCommentBody(comment) {
  if (comment.body && typeof comment.body === 'object' && comment.body.body) {
    return stripHtml(comment.body.body);
  }
  if (typeof comment.body === 'string') return stripHtml(comment.body);
  if (comment.body_plain_text) return comment.body_plain_text;
  return '';
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function getEmbedding(text, apiKey) {
  var truncated = text.substring(0, 8000);
  var resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: truncated,
      dimensions: 1536
    })
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('OpenAI embedding failed: ' + err.substring(0, 200));
  }
  var data = await resp.json();
  return data.data[0].embedding;
}

async function upsertToSupabase(url, key, record) {
  var resp = await fetch(url + '/rest/v1/posts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify(record)
  });
  if (!resp.ok) {
    var err = await resp.text();
    throw new Error('Supabase upsert failed: ' + err.substring(0, 200));
  }
}

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

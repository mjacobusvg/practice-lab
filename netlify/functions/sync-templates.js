// netlify/functions/sync-templates.js
// Scans posts table for template/cheatsheet candidates and upserts into templates table
// Called from template-admin.html with backfill secret

exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: '' };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (body.secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Invalid secret' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  const TEMPLATE_KEYWORDS = [
    'template', 'macro', 'dot phrase', 'dotphrase', 'cheat sheet', 'cheatsheet',
    'sample language', 'downloadable', 'snippet', 'script', 'reference card',
    'letter template', 'appeal letter', 'documentation template', 'note template'
  ];

  const EXCLUDED_SPACES = ['start here', 'welcome', 'announcements', 'forum updates'];

  try {
    // Fetch all posts — paginate in batches of 500
    let allPosts = [];
    let offset = 0;
    const batchSize = 500;

    while (true) {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/posts?select=id,circle_post_id,title,body,author,space_name,url,created_at&order=created_at.desc&limit=${batchSize}&offset=${offset}`,
        { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
      );
      if (!res.ok) throw new Error('Posts fetch failed: ' + res.status);
      const batch = await res.json();
      if (!batch.length) break;
      allPosts = allPosts.concat(batch);
      if (batch.length < batchSize) break;
      offset += batchSize;
    }

    // Filter for template candidates
    const candidates = allPosts.filter(function(post) {
      if (!post.url) return false;
      if (EXCLUDED_SPACES.some(function(ex) {
        return (post.space_name || '').toLowerCase().includes(ex);
      })) return false;

      const searchText = ((post.title || '') + ' ' + (post.body || '')).toLowerCase();
      return TEMPLATE_KEYWORDS.some(function(kw) { return searchText.includes(kw); });
    });

    // Upsert candidates into templates table
    // Only insert if not already present (by circle_post_id)
    // Get existing template post IDs first
    const existingRes = await fetch(
      `${supabaseUrl}/rest/v1/templates?select=circle_post_id`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
    );
    const existing = existingRes.ok ? await existingRes.json() : [];
    const existingIds = new Set(existing.map(function(e) { return e.circle_post_id; }));

    const toInsert = candidates.filter(function(p) {
      return !existingIds.has(p.circle_post_id);
    });

    let inserted = 0;
    if (toInsert.length > 0) {
      const rows = toInsert.map(function(p) {
        return {
          post_id: p.id,
          circle_post_id: p.circle_post_id,
          title: p.title,
          url: p.url,
          space_name: p.space_name,
          author: p.author,
          body_preview: (p.body || '').substring(0, 400),
          type: 'unreviewed',
          approved: false
        };
      });

      // Insert in batches of 50
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        await fetch(`${supabaseUrl}/rest/v1/templates`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(batch)
        });
        inserted += batch.length;
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        scanned: allPosts.length,
        candidates: candidates.length,
        newlyInserted: inserted,
        alreadyPresent: candidates.length - toInsert.length
      })
    };

  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

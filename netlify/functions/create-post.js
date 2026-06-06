// netlify/functions/create-post.js
// Admin composer endpoint: creates posts and updates canonical synthesis / CE flags.
// Writes with the Supabase service role key so RLS stays locked for anon clients.
//
// Required env vars (Netlify site settings):
//   SUPABASE_URL                e.g. https://ubcrrrapedaxkguxniwv.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   service_role key (never expose client-side)

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];
const MICHAEL_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

// Space slug -> must match the slugs in the spaces table / platform.html GROUPS
const VALID_SPACES = [
  'start-here','announcements','quick-q','member-threads','case-discussions',
  'billing-docs','workflow','licensing','clinical-ref','practice-growth',
  'toolkit','tool-feedback','shared-clinical','ethics','critical',
  'clinical-insights','modalities'
];

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Plain text -> simple paragraph HTML (blank lines = paragraph breaks)
function toHtml(plain) {
  return plain
    .split(/\n{2,}/)
    .map(p => '<p>' + esc(p.trim()).replace(/\n/g, '<br>') + '</p>')
    .join('\n');
}

async function sb(path, method, body, env) {
  const res = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    method,
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 200));
  return data;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  // Admin gate. Client-supplied email matched against allowlist: same trust
  // posture as the existing auth-gate. Tighten when Supabase Auth lands.
  const email = String(p.email || '').toLowerCase().trim();
  if (ADMIN_EMAILS.indexOf(email) === -1) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  try {
    if (p.action === 'create') {
      const title = String(p.title || '').trim();
      const body = String(p.body || '').trim();
      const space = String(p.space || '').trim();
      if (!title || !body) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Title and body required' }) };
      if (VALID_SPACES.indexOf(space) === -1) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown space' }) };

      const spaces = await sb('spaces?slug=eq.' + encodeURIComponent(space) + '&select=id', 'GET', null, env);
      if (!spaces || !spaces.length) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Space not found' }) };

      const excerpt = body.replace(/\s+/g, ' ').slice(0, 200);
      const row = {
        space_id: spaces[0].id,
        author_id: MICHAEL_ACCOUNT_ID,
        title: title,
        body_plain: body,
        body_html: toHtml(body),
        excerpt: excerpt,
        comment_count: 0,
        reaction_count: 0,
        canonical_synthesis: p.synthesis ? String(p.synthesis).trim() || null : null,
        ce_candidate: !!p.ce_candidate,
        post_type: 'discussion'
      };
      const inserted = await sb('forum_posts', 'POST', row, env);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, post_id: inserted[0].id }) };
    }

    if (p.action === 'synthesis') {
      const postId = String(p.post_id || '').trim();
      if (!postId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'post_id required' }) };
      const patch = {
        canonical_synthesis: String(p.synthesis || '').trim() || null,
        ce_candidate: !!p.ce_candidate
      };
      const updated = await sb('forum_posts?id=eq.' + encodeURIComponent(postId), 'PATCH', patch, env);
      if (!updated || !updated.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Post not found' }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, post_id: postId }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

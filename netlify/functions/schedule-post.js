// netlify/functions/schedule-post.js
// Admin-only: schedule an announcement/post to publish at a future time, list
// upcoming scheduled posts, or cancel one. Actual publishing is done by
// publish-scheduled.js (a cron). Writes with the service key.
//
// Actions:
//   { token, action:'create', space, title, body, publish_at, email_blast?, pin? }
//   { token, action:'list' }
//   { token, action:'cancel', id }

const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];
const VALID_SPACES = [
  'start-here', 'announcements', 'quick-q', 'member-threads', 'case-discussions',
  'billing-docs', 'workflow', 'licensing', 'clinical-ref', 'practice-growth',
  'toolkit', 'tool-feedback', 'shared-clinical', 'ethics', 'critical',
  'clinical-insights', 'modalities'
];

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

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

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Bad JSON' }) }; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  const email = String(session.claims && session.claims.email || '').toLowerCase();
  if (!session.valid || ADMIN_EMAILS.indexOf(email) === -1) return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };

  try {
    if (p.action === 'create') {
      const space = String(p.space || '').trim();
      const title = String(p.title || '').trim();
      const body = String(p.body || '').trim();
      const when = new Date(p.publish_at);
      if (VALID_SPACES.indexOf(space) === -1) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown space' }) };
      if (!title || !body) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Title and body are required' }) };
      if (isNaN(when.getTime())) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid date' }) };
      if (when.getTime() < Date.now() + 60000) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Schedule at least a minute in the future.' }) };

      const row = {
        space: space, title: title, body: body,
        publish_at: when.toISOString(),
        email_blast: p.email_blast !== false,
        pin: !!p.pin,
        free_visible: !!p.free_visible,   // carried to the published post (publish-scheduled reads it)
        ce_candidate: !!p.ce_candidate,   // carried to the published post (ANCC needs-assessment evidence)
        members_teaser: (p.members_teaser && String(p.members_teaser).trim()) || null,   // locked-section teaser, carried through
        members_extra: (p.members_extra && String(p.members_extra).trim()) || null,      // locked-section body, carried through
        created_by: email
      };
      const ins = await sb('scheduled_posts', 'POST', row, 'return=representation');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id: ins && ins[0] && ins[0].id }) };
    }

    if (p.action === 'list') {
      const rows = await sb('scheduled_posts?status=eq.scheduled&order=publish_at.asc&select=id,space,title,publish_at,email_blast,pin,free_visible,ce_candidate,members_teaser', 'GET');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, items: rows || [] }) };
    }

    if (p.action === 'cancel') {
      const id = String(p.id || '').trim();
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'id required' }) };
      await sb('scheduled_posts?id=eq.' + encodeURIComponent(id) + '&status=eq.scheduled', 'PATCH', { status: 'canceled' }, 'return=minimal');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

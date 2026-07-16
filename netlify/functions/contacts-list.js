// netlify/functions/contacts-list.js
// Admin-only read of the community roster (public.contacts) plus tier counts.
// This is the "who is on our list, and at what tier" view that replaces having
// to log into Circle. Aggregated server-side with the service key (contacts is
// RLS-locked and not readable by the anon client).
//
// Body: { token, tier?, q?, limit?, offset? }
//   tier : 'free' | 'forum' | 'full' | 'members' | 'nonmembers' | 'all'
//   q    : case-insensitive substring match on email or name
// -> { ok, counts:{total,free,forum,full,members,subscribed}, contacts:[...] }

const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing env' }) };
  const auth = { apikey: KEY, Authorization: 'Bearer ' + KEY };

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid || ADMIN_EMAILS.indexOf(String(session.claims.email || '').toLowerCase()) === -1) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };
  }

  const countOf = async (qs) => {
    const res = await fetch(URL + '/rest/v1/contacts?' + qs, { headers: Object.assign({ Prefer: 'count=exact', Range: '0-0' }, auth) });
    const cr = res.headers.get('content-range') || '';
    return parseInt((cr.split('/')[1] || '0'), 10) || 0;
  };

  try {
    const [total, free, forum, full, subscribed] = await Promise.all([
      countOf('select=email'),
      countOf('tier=eq.free&select=email'),
      countOf('tier=eq.forum&select=email'),
      countOf('tier=eq.full&select=email'),
      countOf('subscribed=eq.true&select=email')
    ]);

    // Filtered list.
    const parts = ['select=email,name,first_name,tier,circle_status,subscribed,source,updated_at', 'order=tier.asc,email.asc'];
    const tier = String(p.tier || 'all').toLowerCase();
    if (tier === 'members') parts.push('tier=in.(forum,full)');
    else if (tier === 'nonmembers') parts.push('tier=eq.free');
    else if (tier === 'free' || tier === 'forum' || tier === 'full') parts.push('tier=eq.' + tier);
    const q = String(p.q || '').trim();
    if (q) {
      const enc = encodeURIComponent('%' + q.replace(/[%_]/g, '') + '%');
      parts.push('or=(email.ilike.' + enc + ',name.ilike.' + enc + ')');
    }
    const limit = Math.min(Math.max(parseInt(p.limit, 10) || 200, 1), 1000);
    const offset = Math.max(parseInt(p.offset, 10) || 0, 0);
    parts.push('limit=' + limit); parts.push('offset=' + offset);

    const res = await fetch(URL + '/rest/v1/contacts?' + parts.join('&'), { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
    const rows = res.ok ? await res.json() : [];

    return {
      statusCode: 200, headers, body: JSON.stringify({
        ok: true,
        counts: { total: total, free: free, forum: forum, full: full, members: forum + full, subscribed: subscribed },
        contacts: rows || []
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

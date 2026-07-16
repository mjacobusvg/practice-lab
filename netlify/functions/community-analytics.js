// netlify/functions/community-analytics.js
// Admin-only community analytics for the platform: members by tier + new signups,
// active users + page views, content volume (posts/comments/reactions/DMs), AI
// tool usage, and the top threads. Aggregated server-side with the service key
// (these tables are not readable by the anon client).
//
// Body: { token }  ->  { ok, members, activity, content, ai, top_posts, new_members, signups_daily }

const { verifyToken } = require('./_lib/session');

const ADMIN_EMAILS = ['michael@thinkbeyondpsych.com'];

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

  let p; try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(token);
  if (!session.valid || ADMIN_EMAILS.indexOf(String(session.claims.email || '').toLowerCase()) === -1) {
    return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Admin only' }) };
  }

  const sb = async (path) => {
    const res = await fetch(URL + '/rest/v1/' + path, { headers: Object.assign({ 'Content-Type': 'application/json' }, auth) });
    if (!res.ok) return [];
    const t = await res.text();
    return t ? JSON.parse(t) : [];
  };
  const countOf = async (path) => {
    const res = await fetch(URL + '/rest/v1/' + path, { headers: Object.assign({ Prefer: 'count=exact', Range: '0-0' }, auth) });
    const cr = res.headers.get('content-range') || '';
    return parseInt((cr.split('/')[1] || '0'), 10) || 0;
  };
  const iso = (days) => new Date(Date.now() - days * 864e5).toISOString();
  const d7 = encodeURIComponent(iso(7)), d30 = encodeURIComponent(iso(30));

  try {
    const [total, free, forum, full, new7, new30] = await Promise.all([
      countOf('accounts?select=id'),
      countOf('accounts?tier=eq.free&select=id'),
      countOf('accounts?tier=eq.forum&select=id'),
      countOf('accounts?tier=eq.full&select=id'),
      countOf('accounts?created_at=gt.' + d7 + '&select=id'),
      countOf('accounts?created_at=gt.' + d30 + '&select=id')
    ]);

    const [views7, views30, posts_total, posts7, comments_total, comments7, reactions_total, dms7, ai7, ai30] = await Promise.all([
      countOf('page_views?viewed_at=gt.' + d7 + '&select=id'),
      countOf('page_views?viewed_at=gt.' + d30 + '&select=id'),
      countOf('forum_posts?select=id'),
      countOf('forum_posts?created_at=gt.' + d7 + '&select=id'),
      countOf('forum_comments?select=id'),
      countOf('forum_comments?created_at=gt.' + d7 + '&select=id'),
      countOf('reactions?select=id'),
      countOf('dm_messages?created_at=gt.' + d7 + '&select=id'),
      countOf('tool_usage?created_at=gt.' + d7 + '&select=id'),
      countOf('tool_usage?created_at=gt.' + d30 + '&select=id')
    ]);

    // Active users: distinct emails in page_views over each window (small tables;
    // dedupe in JS with a bounded fetch).
    const pvRows = await sb('page_views?viewed_at=gt.' + d30 + '&select=email,viewed_at&limit=5000');
    const set7 = {}, set30 = {};
    pvRows.forEach(function (r) {
      if (!r.email) return;
      set30[r.email] = true;
      if (new Date(r.viewed_at).getTime() > Date.now() - 7 * 864e5) set7[r.email] = true;
    });

    const top_posts = await sb('forum_posts?select=id,title,comment_count,reaction_count&order=comment_count.desc.nullslast,reaction_count.desc.nullslast&limit=8');
    const new_members = await sb('accounts?select=name,tier,created_at&order=created_at.desc&limit=8');

    // New signups per day, last 14 days.
    const signupRows = await sb('accounts?created_at=gt.' + encodeURIComponent(iso(14)) + '&select=created_at&limit=2000');
    const daily = {};
    for (let i = 0; i < 14; i++) daily[new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)] = 0;
    signupRows.forEach(function (r) { const k = String(r.created_at).slice(0, 10); if (k in daily) daily[k]++; });
    const signups_daily = Object.keys(daily).sort().map(function (k) { return [k, daily[k]]; });

    // ── Tool usage by member ──────────────────────────────────────────────────
    // Attribute every AI-tool event to a person and split real members from the
    // admin's own account, disposable test accounts, and pre-attribution
    // (email-less) events, so "who actually uses the tools" is answerable.
    const ADMIN_SET = ADMIN_EMAILS.map(function (e) { return e.toLowerCase(); });
    const isTest = function (e) { return /@slmails\.com$/i.test(e) || /\+test/i.test(e); };
    const tuRows = await sb('tool_usage?select=account_email,tool,tier,created_at&order=created_at.desc&limit=20000');
    const memberByEmail = {}, memberByTool = {}, youByTool = {};
    let youEvents = 0, anonEvents = 0, testEvents = 0, memberEvents = 0;
    tuRows.forEach(function (r) {
      const em = String(r.account_email || '').toLowerCase();
      if (!em) { anonEvents++; return; }
      if (ADMIN_SET.indexOf(em) !== -1) { youEvents++; youByTool[r.tool] = (youByTool[r.tool] || 0) + 1; return; }
      if (isTest(em)) { testEvents++; return; }
      memberEvents++;
      if (!memberByEmail[em]) memberByEmail[em] = { email: em, tier: r.tier || null, events: 0, tools: {}, last: r.created_at };
      memberByEmail[em].events++;
      memberByEmail[em].tools[r.tool] = true;
      if (!memberByTool[r.tool]) memberByTool[r.tool] = { members: {}, events: 0 };
      memberByTool[r.tool].members[em] = true;
      memberByTool[r.tool].events++;
    });
    const by_member = Object.keys(memberByEmail).map(function (k) {
      const mm = memberByEmail[k];
      return { email: mm.email, tier: mm.tier, events: mm.events, tools: Object.keys(mm.tools).length, last: mm.last };
    }).sort(function (a, b) { return b.events - a.events; });
    const by_tool = Object.keys(memberByTool).map(function (k) {
      return { tool: k, members: Object.keys(memberByTool[k].members).length, events: memberByTool[k].events };
    }).sort(function (a, b) { return b.events - a.events; });
    const you_by_tool = Object.keys(youByTool).map(function (k) { return { tool: k, events: youByTool[k] }; })
      .sort(function (a, b) { return b.events - a.events; });
    const tools = {
      member_users: by_member.length, member_events: memberEvents,
      by_member: by_member, by_tool: by_tool,
      excluded: { you: youEvents, anon: anonEvents, test: testEvents },
      you_by_tool: you_by_tool
    };

    // ── Support signals: client errors + problem reports ─────────────────────
    const [errors_recent, reports_recent, errors_24h, reports_open] = await Promise.all([
      sb('client_errors?select=message,page,email,tier,created_at&order=created_at.desc&limit=15'),
      sb('problem_reports?select=message,page,email,tier,status,created_at&order=created_at.desc&limit=15'),
      countOf('client_errors?created_at=gt.' + encodeURIComponent(iso(1)) + '&select=id'),
      countOf('problem_reports?status=eq.open&select=id')
    ]);
    const signals = {
      errors_24h: errors_24h, reports_open: reports_open,
      errors_recent: errors_recent || [], reports_recent: reports_recent || []
    };

    return {
      statusCode: 200, headers, body: JSON.stringify({
        ok: true,
        members: { total: total, free: free, forum: forum, full: full, new_7d: new7, new_30d: new30 },
        activity: { views_7d: views7, views_30d: views30, active_7d: Object.keys(set7).length, active_30d: Object.keys(set30).length },
        content: { posts_total: posts_total, posts_7d: posts7, comments_total: comments_total, comments_7d: comments7, reactions_total: reactions_total, dms_7d: dms7 },
        ai: { calls_7d: ai7, calls_30d: ai30 },
        top_posts: top_posts || [],
        new_members: new_members || [],
        signups_daily: signups_daily,
        tools: tools,
        signals: signals
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

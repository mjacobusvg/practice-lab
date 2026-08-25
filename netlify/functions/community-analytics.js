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

  // Clear (acknowledge) client errors: soft — sets cleared_at so they drop off the
  // dashboard while the rows stay in the DB for history. Admin-only (gated above).
  if (p.action === 'clear_errors') {
    try {
      const r = await fetch(URL + '/rest/v1/client_errors?cleared_at=is.null', {
        method: 'PATCH',
        headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, auth),
        body: JSON.stringify({ cleared_at: new Date().toISOString() })
      });
      return { statusCode: r.ok ? 200 : 500, headers, body: JSON.stringify({ ok: r.ok }) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
    }
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

    // Net-new PAID members: those who were NEVER on Circle (circle_member_id IS NULL)
    // and are on a paid tier. This is real post-launch growth — distinct from migrated
    // members renewing. (Free net-new is dominated by pre-created contacts, so we
    // surface paid only.) Also a duplicate-signup smell test: a name/practice that
    // matches an existing Circle member here may be a second account.
    const net_new_paid = await sb('accounts?circle_member_id=is.null&tier=in.(forum,full)&select=name,email,tier,created_at&order=created_at.desc&limit=50');

    // ── Real membership truth ────────────────────────────────────────────────
    // Tier reconciled against the active PAID subscription, with owner alts + comps
    // set aside and annual subs normalized to monthly. THIS is what "paying members"
    // and "MRR" actually mean — unlike the raw tier counts above, which lump comps,
    // alts, grandfathered $89 fulls, past-dues, and annual subs together.
    const mtRows = await sb('membership_truth?select=email,name,status_truth,mrr_usd,price_usd');
    const truth = {
      paying: 0, paying_full: 0, paying_forum: 0, free: 0, comp: 0, owner_alt: 0,
      past_due_full: 0, past_due_forum: 0, access_no_sub: 0, mrr: 0, full_by_price: {}, past_due: []
    };
    (mtRows || []).forEach(function (r) {
      const st = r.status_truth, mrr = Number(r.mrr_usd) || 0;
      if (st === 'paying_full') { truth.paying_full++; truth.mrr += mrr; const k = String(r.price_usd); truth.full_by_price[k] = (truth.full_by_price[k] || 0) + 1; }
      else if (st === 'paying_forum') { truth.paying_forum++; truth.mrr += mrr; }
      else if (st === 'free') truth.free++;
      else if (st === 'comp') truth.comp++;
      else if (st === 'owner_alt') truth.owner_alt++;
      else if (st === 'past_due_full') { truth.past_due_full++; truth.past_due.push({ name: r.name, email: r.email, tier: 'full', usd: r.price_usd }); }
      else if (st === 'past_due_forum') { truth.past_due_forum++; truth.past_due.push({ name: r.name, email: r.email, tier: 'forum', usd: r.price_usd }); }
      else if (st === 'access_no_active_sub') truth.access_no_sub++;
    });
    truth.paying = truth.paying_full + truth.paying_forum;
    truth.mrr = Math.round(truth.mrr * 100) / 100;

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
    // Only plus-addressed +test aliases are test noise. @slmails.com is a real email privacy
    // relay used by real members, not a test/disposable domain — count those as real usage.
    const isTest = function (e) { return /\+test/i.test(e); };
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

    // ── Why members joined (paid-welcome one-click survey) ───────────────────
    // signup_reasons is written by signup-reason.js when a new paying member taps
    // an answer in the welcome email. Aggregate into a labeled breakdown so the
    // Analytics tab shows WHY people actually convert, not just that they did.
    const REASON_LABELS = {
      scribe: 'AI Scribe', coding: 'Coding & audit', community: 'Community & archive',
      tools: 'Practice & credentialing tools', all: 'Total package', other: 'Other'
    };
    const srRows = await sb('signup_reasons?select=reason&limit=5000');
    const srCounts = {};
    (srRows || []).forEach(function (r) { const k = r.reason || 'other'; srCounts[k] = (srCounts[k] || 0) + 1; });
    const srTotal = Object.keys(srCounts).reduce(function (n, k) { return n + srCounts[k]; }, 0);
    const signup_reasons = {
      total: srTotal,
      breakdown: Object.keys(srCounts).map(function (k) {
        return { reason: k, label: REASON_LABELS[k] || k, count: srCounts[k], pct: srTotal ? Math.round(srCounts[k] / srTotal * 100) : 0 };
      }).sort(function (a, b) { return b.count - a.count; })
    };

    // ── Support signals: client errors + problem reports ─────────────────────
    const [errors_recent, reports_recent, errors_24h, reports_open] = await Promise.all([
      sb('client_errors?cleared_at=is.null&select=message,page,email,tier,created_at&order=created_at.desc&limit=15'),
      sb('problem_reports?select=message,page,email,tier,status,created_at&order=created_at.desc&limit=15'),
      countOf('client_errors?cleared_at=is.null&created_at=gt.' + encodeURIComponent(iso(1)) + '&select=id'),
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
        membership: truth,
        activity: { views_7d: views7, views_30d: views30, active_7d: Object.keys(set7).length, active_30d: Object.keys(set30).length },
        content: { posts_total: posts_total, posts_7d: posts7, comments_total: comments_total, comments_7d: comments7, reactions_total: reactions_total, dms_7d: dms7 },
        ai: { calls_7d: ai7, calls_30d: ai30 },
        top_posts: top_posts || [],
        new_members: new_members || [],
        net_new_paid: net_new_paid || [],
        signups_daily: signups_daily,
        signup_reasons: signup_reasons,
        tools: tools,
        signals: signals
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

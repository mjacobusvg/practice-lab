// netlify/functions/admin-dashboard.js
// Serves aggregated data for the Think Beyond admin dashboard

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

  async function query(path) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
    });
    return res.ok ? res.json() : [];
  }

  try {
    const [archiveJobs, unanswered, feedback, practiceLabUsage] = await Promise.all([
      query('archive_jobs?select=created_at&order=created_at.desc&limit=1000'),
      query('unanswered_questions?select=question,created_at&order=created_at.desc&limit=500'),
      query('archive_feedback?select=rating,created_at&limit=1000').catch(() => []),
      query('tool_usage?select=tool,mode,created_at&order=created_at.desc&limit=2000').catch(() => [])
    ]);

    // Archive stats
    const archiveTotal = archiveJobs.length;
    const archiveThisWeek = archiveJobs.filter(function(j) {
      return new Date(j.created_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    }).length;
    const archiveToday = archiveJobs.filter(function(j) {
      return new Date(j.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000);
    }).length;

    // Feedback stats
    const thumbsUp = feedback.filter(function(f) { return f.rating === 1; }).length;
    const thumbsDown = feedback.filter(function(f) { return f.rating === -1; }).length;

    // Unanswered stats
    const unansweredTotal = unanswered.length;
    const unansweredThisWeek = unanswered.filter(function(u) {
      return new Date(u.created_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    }).length;

    // Practice Lab stats
    const plTotal = practiceLabUsage.length;
    const plThisWeek = practiceLabUsage.filter(function(u) {
      return new Date(u.created_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    }).length;
    const plToday = practiceLabUsage.filter(function(u) {
      return new Date(u.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000);
    }).length;

    // Practice Lab by mode
    const plByMode = {};
    practiceLabUsage.forEach(function(u) {
      plByMode[u.mode] = (plByMode[u.mode] || 0) + 1;
    });

    // Daily activity last 14 days for both tools
    function dailyActivity(rows, dateField, days) {
      const result = {};
      for (let i = 0; i < days; i++) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().split('T')[0];
        result[key] = 0;
      }
      rows.forEach(function(r) {
        const key = new Date(r[dateField]).toISOString().split('T')[0];
        if (key in result) result[key]++;
      });
      return Object.entries(result).sort(function(a, b) { return a[0].localeCompare(b[0]); });
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        archive: {
          total: archiveTotal,
          thisWeek: archiveThisWeek,
          today: archiveToday,
          unansweredTotal,
          unansweredThisWeek,
          thumbsUp,
          thumbsDown,
          daily: dailyActivity(archiveJobs, 'created_at', 14)
        },
        practiceLab: {
          total: plTotal,
          thisWeek: plThisWeek,
          today: plToday,
          byMode: plByMode,
          daily: dailyActivity(practiceLabUsage, 'created_at', 14)
        }
      })
    };

  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

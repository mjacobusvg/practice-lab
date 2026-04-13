// netlify/functions/admin-dashboard.js
// Serves aggregated data for the Think Beyond admin dashboard
// Also handles referral attribution fetch and update actions

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

  // ========== ACTION: update_referral ==========
  if (body.action === 'update_referral') {
    const { id, day_16_status, payout_status } = body;
    if (!id) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing referral id' }) };
    }

    const updates = {};
    if (day_16_status !== undefined) updates.day_16_status = day_16_status;
    if (payout_status !== undefined) {
      updates.payout_status = payout_status;
      if (payout_status === 'paid') {
        updates.payout_date = new Date().toISOString();
      } else {
        updates.payout_date = null;
      }
    }

    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/referral_attributions?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(updates)
      });

      if (!res.ok) {
        const errText = await res.text();
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Update failed: ' + errText }) };
      }

      const updated = await res.json();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, row: updated[0] }) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ========== ACTION: delete_referral ==========
  if (body.action === 'delete_referral') {
    const { id } = body;
    if (!id) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing referral id' }) };
    }

    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/referral_attributions?id=eq.${id}`, {
        method: 'DELETE',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      });

      if (!res.ok) {
        const errText = await res.text();
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Delete failed: ' + errText }) };
      }

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ========== DEFAULT: dashboard data ==========
  try {
    const [archiveJobs, unanswered, feedback, practiceLabUsage, referrals] = await Promise.all([
      query('archive_jobs?select=created_at&order=created_at.desc&limit=1000'),
      query('unanswered_questions?select=question,created_at&order=created_at.desc&limit=500'),
      query('archive_feedback?select=rating,created_at&limit=1000').catch(() => []),
      query('tool_usage?select=tool,mode,created_at&order=created_at.desc&limit=2000').catch(() => []),
      query('referral_attributions?select=*&order=created_at.desc&limit=500').catch(() => [])
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

    // Referral stats
    const REFERRAL_PAYOUT = 75; // $ per referral (Denis rate; standard for non-member referrers)
    const refTotal = referrals.length;
    const refPending = referrals.filter(function(r) { return r.day_16_status === 'pending'; }).length;
    const refActive = referrals.filter(function(r) {
      return r.day_16_status === 'active' && r.payout_status === 'pending';
    }).length;
    const refPaid = referrals.filter(function(r) { return r.payout_status === 'paid'; }).length;
    const refRefunded = referrals.filter(function(r) { return r.day_16_status === 'refunded'; }).length;
    const refOwed = refActive * REFERRAL_PAYOUT;
    const refPaidTotal = refPaid * REFERRAL_PAYOUT;

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
        },
        referrals: {
          total: refTotal,
          pending: refPending,
          active: refActive,
          paid: refPaid,
          refunded: refRefunded,
          owed: refOwed,
          paidTotal: refPaidTotal,
          payoutRate: REFERRAL_PAYOUT,
          rows: referrals
        }
      })
    };

  } catch(e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};

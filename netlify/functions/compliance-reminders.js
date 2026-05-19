// netlify/functions/compliance-reminders.js
// Scheduled daily: checks all users' tracking items for approaching deadlines
// Sends email reminders via Resend at 90, 60, 30, 14, 7, and 1 day(s) before due date
// Also flags overdue items and auto-advances stale recurring items
//
// Schedule: daily at 8am ET (configure in netlify.toml)
// [[scheduled_functions]]
//   name = "compliance-reminders"
//   schedule = "0 12 * * *"

var crypto = require('crypto');

exports.handler = async function(event) {
  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  var resendKey = process.env.RESEND_API_KEY;
  var actionSecret = process.env.COMPLIANCE_ACTION_SECRET || supabaseKey;

  if (!supabaseUrl || !supabaseKey || !resendKey) {
    console.log('Missing environment variables');
    return { statusCode: 500, body: 'Config missing' };
  }

  var supaHeaders = {
    'apikey': supabaseKey,
    'Authorization': 'Bearer ' + supabaseKey,
    'Content-Type': 'application/json'
  };

  // Fetch all compliance tracker data
  var tableUrl = supabaseUrl + '/rest/v1/user_tool_data?tool_id=eq.compliance_tracker&select=email,data,updated_at';
  var res = await fetch(tableUrl, { headers: supaHeaders });
  if (!res.ok) { console.log('Failed to fetch tracker data'); return { statusCode: 500 }; }
  var rows = await res.json();
  if (!rows || rows.length === 0) { console.log('No tracker data found'); return { statusCode: 200, body: 'No data' }; }

  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var reminderWindows = [90, 60, 30, 14, 7, 1];
  var emailsSent = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var email = row.email;
    var data = row.data;
    if (!data || !data.items || !Array.isArray(data.items)) continue;

    var reminders = [];
    var overdue = [];
    var autoAdvanced = false;

    data.items.forEach(function(item) {
      if (!item.dueDate || item.status === 'complete' || item.status === 'dismissed') return;
      var due = new Date(item.dueDate);
      due.setHours(0, 0, 0, 0);
      var daysUntil = Math.round((due - today) / 86400000);

      // Auto-advance: if recurring item is 30+ days overdue, assume handled and generate next cycle
      if (daysUntil < -30 && item.recurrence) {
        item.status = 'complete';
        item.completedAt = today.toISOString();
        item.autoAdvanced = true;
        var nextDate = calcNext(item.dueDate, item.recurrence);
        if (nextDate) {
          data.items.push({
            id: 'trk_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6),
            category: item.category,
            title: item.title,
            dueDate: nextDate,
            status: 'active',
            notes: item.notes,
            source: item.source,
            confidence: item.confidence,
            recurrence: item.recurrence,
            createdAt: today.toISOString(),
            previousCycleId: item.id
          });
          autoAdvanced = true;
        }
        return; // Skip reminders for this item since it was auto-advanced
      }

      if (daysUntil < 0) {
        var completeToken = crypto.createHmac('sha256', actionSecret).update(email + item.id + 'complete').digest('hex').substring(0, 32);
        overdue.push({
          title: item.title, category: item.category, daysOverdue: Math.abs(daysUntil),
          id: item.id, actionUrl: item.actionUrl || '', notes: item.notes || '',
          completeLink: 'https://thinkbeyondpractice.com/.netlify/functions/compliance-action?email=' + encodeURIComponent(email) + '&item=' + encodeURIComponent(item.id) + '&action=complete&token=' + completeToken
        });
      } else if (reminderWindows.indexOf(daysUntil) !== -1) {
        var reminderKey = item.id + '_' + daysUntil;
        if (!data._sentReminders || data._sentReminders.indexOf(reminderKey) === -1) {
          var cToken = crypto.createHmac('sha256', actionSecret).update(email + item.id + 'complete').digest('hex').substring(0, 32);
          reminders.push({
            title: item.title, category: item.category, daysUntil: daysUntil, reminderKey: reminderKey,
            id: item.id, actionUrl: item.actionUrl || '', notes: item.notes || '',
            completeLink: 'https://thinkbeyondpractice.com/.netlify/functions/compliance-action?email=' + encodeURIComponent(email) + '&item=' + encodeURIComponent(item.id) + '&action=complete&token=' + cToken
          });
        }
      }
    });

    if (reminders.length === 0 && overdue.length === 0) {
      if (autoAdvanced) {
        var updateUrl2 = supabaseUrl + '/rest/v1/user_tool_data?email=eq.' + encodeURIComponent(email) + '&tool_id=eq.compliance_tracker';
        await fetch(updateUrl2, {
          method: 'PATCH',
          headers: Object.assign({}, supaHeaders, { 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ data: data, updated_at: new Date().toISOString() })
        });
      }
      continue;
    }

    // Build email
    var subject = '';
    var body = '';

    if (overdue.length > 0 && reminders.length > 0) {
      subject = overdue.length + ' overdue, ' + reminders.length + ' upcoming compliance item' + (reminders.length > 1 ? 's' : '');
    } else if (overdue.length > 0) {
      subject = overdue.length + ' overdue compliance item' + (overdue.length > 1 ? 's' : '') + ' need attention';
    } else {
      subject = reminders.length + ' compliance deadline' + (reminders.length > 1 ? 's' : '') + ' approaching';
    }

    body = 'Hi,\n\nHere is your compliance status update from Think Beyond Practice.\n\n';

    if (overdue.length > 0) {
      body += 'OVERDUE:\n\n';
      overdue.forEach(function(o) {
        body += '  [!] ' + o.title + ' (' + o.category + ') - ' + o.daysOverdue + ' day' + (o.daysOverdue > 1 ? 's' : '') + ' overdue\n';
        if (o.actionUrl) body += '      File/renew here: ' + o.actionUrl + '\n';
        body += '      Mark complete: ' + o.completeLink + '\n\n';
      });
    }

    if (reminders.length > 0) {
      body += 'UPCOMING:\n\n';
      reminders.forEach(function(r) {
        body += '  ' + r.title + ' (' + r.category + ') - due in ' + r.daysUntil + ' day' + (r.daysUntil > 1 ? 's' : '') + '\n';
        if (r.actionUrl) body += '      File/renew here: ' + r.actionUrl + '\n';
        body += '      Mark complete: ' + r.completeLink + '\n\n';
      });
    }

    body += 'Review your full compliance dashboard:\nhttps://thinkbeyondpractice.com/compliance-tracker\n\n';
    body += 'Think Beyond Practice\nThis is an automated reminder. You can manage notification preferences in the Compliance Tracker settings.';

    // Send via Resend
    try {
      var emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'reminders@thinkbeyondpractice.com',
          to: email,
          subject: 'Practice Compliance: ' + subject,
          text: body
        })
      });
      if (emailRes.ok) emailsSent++;
    } catch(e) { console.log('Email failed for ' + email + ': ' + e.message); }

    // Record sent reminders and save auto-advanced items
    if (reminders.length > 0 || autoAdvanced) {
      if (!data._sentReminders) data._sentReminders = [];
      reminders.forEach(function(r) { data._sentReminders.push(r.reminderKey); });

      // Update the record in Supabase
      var updateUrl = supabaseUrl + '/rest/v1/user_tool_data?email=eq.' + encodeURIComponent(email) + '&tool_id=eq.compliance_tracker';
      await fetch(updateUrl, {
        method: 'PATCH',
        headers: Object.assign({}, supaHeaders, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ data: data, updated_at: new Date().toISOString() })
      });
    }
  }

  console.log('Compliance reminders sent: ' + emailsSent + ' emails to ' + rows.length + ' users');
  return { statusCode: 200, body: 'Sent ' + emailsSent + ' reminder emails' };
};

// Recurrence date calculator (server-side mirror of client-side logic)
function calcNext(currentDueDate, recurrence) {
  var due = new Date(currentDueDate);
  if (isNaN(due.getTime())) return null;
  if (recurrence === 'quarterly') due.setMonth(due.getMonth() + 3);
  else if (recurrence === 'annual') due.setFullYear(due.getFullYear() + 1);
  else if (recurrence === 'biennial') due.setFullYear(due.getFullYear() + 2);
  else if (recurrence === 'every_120_days') due.setDate(due.getDate() + 120);
  else if (recurrence === 'monthly') due.setMonth(due.getMonth() + 1);
  else if (typeof recurrence === 'number') due.setDate(due.getDate() + recurrence);
  else if (recurrence && typeof recurrence === 'object' && recurrence.months) due.setMonth(due.getMonth() + recurrence.months);
  else return null;
  return due.toISOString().split('T')[0];
}

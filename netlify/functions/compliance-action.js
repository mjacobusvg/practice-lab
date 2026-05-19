// netlify/functions/compliance-action.js
// One-click action handler for compliance tracker email links
// Supports: complete (mark item done + generate next cycle)
//
// URL: /.netlify/functions/compliance-action?email=X&item=Y&action=complete&token=Z
// Token is HMAC-SHA256(email + item_id + action, COMPLIANCE_ACTION_SECRET || SUPABASE_SERVICE_KEY)
//
// Returns HTML confirmation page (not JSON, since this is clicked from email)

var crypto = require('crypto');

exports.handler = async function(event) {
  var params = event.queryStringParameters || {};
  var email = (params.email || '').trim().toLowerCase();
  var itemId = (params.item || '').trim();
  var action = (params.action || '').trim();
  var token = (params.token || '').trim();

  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  var secret = process.env.COMPLIANCE_ACTION_SECRET || supabaseKey;

  if (!email || !itemId || !action || !token) {
    return htmlResponse(400, 'Missing Parameters', 'This link appears to be incomplete. Please use the full link from your email.');
  }

  // Verify token
  var expectedToken = crypto.createHmac('sha256', secret).update(email + itemId + action).digest('hex').substring(0, 32);
  if (token !== expectedToken) {
    return htmlResponse(403, 'Invalid Link', 'This link has expired or is invalid. Please check your most recent compliance reminder email for an updated link.');
  }

  if (action !== 'complete') {
    return htmlResponse(400, 'Unknown Action', 'This action is not supported.');
  }

  var supaHeaders = {
    'apikey': supabaseKey,
    'Authorization': 'Bearer ' + supabaseKey,
    'Content-Type': 'application/json'
  };

  // Load tracker data
  var tableUrl = supabaseUrl + '/rest/v1/user_tool_data?email=eq.' + encodeURIComponent(email) + '&tool_id=eq.compliance_tracker&select=data';
  var res = await fetch(tableUrl, { headers: supaHeaders });
  if (!res.ok) return htmlResponse(500, 'Error', 'Could not load your tracker data. Please try again or open the Compliance Tracker directly.');

  var rows = await res.json();
  if (!rows || rows.length === 0) return htmlResponse(404, 'Not Found', 'No tracker data found for this account.');

  var data = rows[0].data;
  if (!data || !data.items) return htmlResponse(404, 'Not Found', 'No tracking items found.');

  var item = data.items.find(function(i) { return i.id === itemId; });
  if (!item) return htmlResponse(404, 'Item Not Found', 'This tracking item was not found. It may have already been completed or removed.');

  if (item.status === 'complete') {
    return htmlResponse(200, 'Already Complete', 'This item was already marked as complete on ' + (item.completedAt ? new Date(item.completedAt).toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'}) : 'a previous date') + '.');
  }

  // Mark complete
  item.status = 'complete';
  item.completedAt = new Date().toISOString();
  item.completedVia = 'email_link';

  var nextCycleMsg = '';

  // Generate next cycle if recurring
  if (item.recurrence && item.dueDate) {
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
        createdAt: new Date().toISOString(),
        previousCycleId: item.id
      });
      nextCycleMsg = ' The next cycle has been scheduled for ' + new Date(nextDate).toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'}) + '.';
    }
  }

  // Save back to Supabase
  var updateUrl = supabaseUrl + '/rest/v1/user_tool_data?email=eq.' + encodeURIComponent(email) + '&tool_id=eq.compliance_tracker';
  var saveRes = await fetch(updateUrl, {
    method: 'PATCH',
    headers: Object.assign({}, supaHeaders, { 'Prefer': 'return=minimal' }),
    body: JSON.stringify({ data: data, updated_at: new Date().toISOString() })
  });

  if (!saveRes.ok) return htmlResponse(500, 'Save Failed', 'The item could not be saved. Please try again or mark it complete in the Compliance Tracker directly.');

  return htmlResponse(200, 'Done!', '"' + item.title + '" has been marked as complete.' + nextCycleMsg + ' You can close this tab.');
};

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

function htmlResponse(statusCode, title, message) {
  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + ' | Compliance Tracker</title>' +
    '<style>body{background:#0b1120;color:#e8e2d6;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}' +
    '.card{background:#111c30;border:1px solid rgba(42,171,184,0.15);border-radius:10px;padding:40px;max-width:480px;text-align:center}' +
    'h1{font-size:1.4rem;color:#f5f4f2;margin:0 0 12px}' +
    'p{font-size:.9rem;line-height:1.6;color:#b0aa9e;margin:0 0 20px}' +
    'a{color:#2aabb8;text-decoration:none;font-weight:600}a:hover{opacity:.8}' +
    '.check{font-size:2.5rem;margin-bottom:16px}</style></head><body>' +
    '<div class="card">' +
    '<div class="check">' + (statusCode === 200 ? '&#x2705;' : '&#x26A0;') + '</div>' +
    '<h1>' + title + '</h1>' +
    '<p>' + message + '</p>' +
    '<a href="https://thinkbeyondpractice.com/compliance-tracker">Open Compliance Tracker</a>' +
    '</div></body></html>';
  return { statusCode: statusCode, headers: { 'Content-Type': 'text/html' }, body: html };
}

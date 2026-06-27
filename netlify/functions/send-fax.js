var { verifyToken } = require('./_lib/session');
// netlify/functions/send-fax.js
// Sends fax via Notifyre REST API (no npm dependencies).
// Accepts document content as text, converts to PDF-ready base64 for transmission.
//
// Environment variables:
//   NOTIFYRE_API_KEY - Notifyre API token
//
// Request body:
//   to: fax number (e.g. "+15095551234")
//   content: plain text content to fax
//   toName: recipient name/office (for cover page)
//   fromName: sender name
//   fromPractice: practice name
//   subject: fax subject/reference
//   tool: which tool sent this (for logging)

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  var apiKey = process.env.NOTIFYRE_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: 'Fax service not configured. Set NOTIFYRE_API_KEY in Netlify environment variables.' })
    };
  }

  try {
    var payload = JSON.parse(event.body);

    // AUTH: clinical sender — full-tier only. Identity from signed token (body.token or
    // Authorization: Bearer). Closes the open send-relay hole (spam/PHI/toll-fraud on our
    // accounts). Server-side callers must forward the provider's token.
    var __authHeader = event.headers.authorization || event.headers.Authorization || '';
    var __sessionToken = (payload.token || __authHeader.replace(/^Bearer\s+/i, '')).trim();
    var __session = verifyToken(__sessionToken);
    if (!__session.valid) {
      return { statusCode: 401, headers: headers, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }
    if (!(__session.claims.scope === 'member' && __session.claims.tier === 'full')) {
      return { statusCode: 403, headers: headers, body: JSON.stringify({ error: 'This tool requires the full Think Beyond Practice membership.' }) };
    }

    var to = payload.to;
    var content = payload.content;
    var toName = payload.toName || '';
    var fromName = payload.fromName || '';
    var fromPractice = payload.fromPractice || '';
    var subject = payload.subject || '';
    var tool = payload.tool || 'Practice Manager';
    var clinicianEmail = payload.clinicianEmail || '';

    if (!to || !content) {
      return {
        statusCode: 400,
        headers: headers,
        body: JSON.stringify({ error: 'Missing required fields: to (fax number) and content' })
      };
    }

    // Clean fax number: strip everything except digits and leading +
    var cleanNumber = to.replace(/[^\d+]/g, '');
    if (!cleanNumber.startsWith('+')) {
      // Assume US number if no country code
      cleanNumber = '+1' + cleanNumber.replace(/^1/, '');
    }

    // Build a simple HTML document for the fax content
    var htmlContent = '<!DOCTYPE html><html><head><style>';
    htmlContent += 'body{font-family:Arial,sans-serif;margin:40px;color:#111;line-height:1.6;font-size:12pt}';
    htmlContent += 'h1{font-size:16pt;margin-bottom:8px}';
    htmlContent += '.header{border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:24px}';
    htmlContent += '.meta{font-size:10pt;color:#444;margin-bottom:4px}';
    htmlContent += '.content{white-space:pre-wrap}';
    htmlContent += '.footer{margin-top:40px;padding-top:12px;border-top:1px solid #ccc;font-size:8pt;color:#666}';
    htmlContent += '</style></head><body>';
    htmlContent += '<div class="header">';
    if (fromPractice) htmlContent += '<h1>' + escHtml(fromPractice) + '</h1>';
    if (fromName) htmlContent += '<div class="meta">From: ' + escHtml(fromName) + '</div>';
    if (toName) htmlContent += '<div class="meta">To: ' + escHtml(toName) + '</div>';
    if (subject) htmlContent += '<div class="meta">Re: ' + escHtml(subject) + '</div>';
    htmlContent += '<div class="meta">Date: ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) + '</div>';
    htmlContent += '</div>';
    htmlContent += '<div class="content">' + escHtml(content) + '</div>';
    htmlContent += '<div class="footer">CONFIDENTIAL: This fax contains Protected Health Information (PHI) intended solely for the named recipient. If received in error, notify the sender immediately and destroy all copies. Unauthorized disclosure is prohibited under HIPAA.</div>';
    htmlContent += '</body></html>';

    // Convert HTML to base64
    var base64Doc = Buffer.from(htmlContent).toString('base64');

    // Step 1: Upload document for conversion
    var uploadRes = await fetch('https://api.notifyre.com/fax/send/conversion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': apiKey
      },
      body: JSON.stringify({
        base64Str: base64Doc,
        contentType: 'text/html'
      })
    });

    var uploadResult = await uploadRes.json();

    if (!uploadRes.ok || !(uploadResult.success || uploadResult.Success)) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: 'Document upload failed', status: uploadRes.status, fullResponse: uploadResult })
      };
    }

    var uploadPayload = uploadResult.payload || uploadResult.Payload || {};
    var fileID = uploadPayload.fileID || uploadPayload.id || uploadPayload.FileID;
    var fileName = uploadPayload.fileName || uploadPayload.FileName;
    if (!fileID && !fileName) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: 'No file ID returned from upload', fullResponse: uploadResult })
      };
    }

    // Step 2: Poll for document conversion status
    var maxAttempts = 15;
    var attempt = 0;
    var docId = null;
    var pollKey = fileName || fileID;

    while (attempt < maxAttempts) {
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      attempt++;

      var statusRes = await fetch('https://api.notifyre.com/fax/send/conversion/' + pollKey, {
        method: 'GET',
        headers: { 'x-api-token': apiKey }
      });

      var statusResult = await statusRes.json();
      var sp = statusResult.payload || statusResult.Payload || {};
      var docStatus = (sp.status || sp.Status || '').toLowerCase();

      if (docStatus === 'successful' || docStatus === 'completed') {
        docId = sp.id || sp.ID || fileID;
        break;
      } else if (docStatus === 'failed') {
        return {
          statusCode: 500,
          headers: headers,
          body: JSON.stringify({ error: 'Document conversion failed', fullResponse: statusResult })
        };
      }
    }

    if (!docId) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: 'Document conversion timed out after ' + attempt + ' attempts' })
      };
    }

    // Step 3: Send the fax
    var faxPayload = {
      faxes: {
        recipients: [
          {
            type: 'fax_number',
            value: cleanNumber
          }
        ],
        files: [docId],
        clientReference: tool + ' - ' + subject + (clinicianEmail ? ' | ' + clinicianEmail : ''),
        isHighQuality: true,
        header: fromPractice || 'Think Beyond Practice'
      }
    };

    var sendRes = await fetch('https://api.notifyre.com/fax/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': apiKey
      },
      body: JSON.stringify(faxPayload)
    });

    var sendResult = await sendRes.json();

    if (!sendRes.ok || !(sendResult.success || sendResult.Success)) {
      return {
        statusCode: 500,
        headers: headers,
        body: JSON.stringify({ error: 'Fax send failed', status: sendRes.status, fullResponse: sendResult })
      };
    }

    // Log to Supabase if available
    var supabaseUrl = process.env.SUPABASE_URL;
    var supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (supabaseUrl && supabaseKey) {
      fetch(supabaseUrl + '/rest/v1/tool_usage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': 'Bearer ' + supabaseKey,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          tool: tool,
          mode: 'send_fax',
          event: 'fax_sent_to_' + cleanNumber.slice(-4),
          created_at: new Date().toISOString()
        })
      }).catch(function(e) { console.log('Usage log error:', e.message); });
    }

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        success: true,
        faxId: (sendResult.payload || sendResult.Payload || {}).faxID || (sendResult.payload || sendResult.Payload || {}).FaxID || null,
        message: 'Fax queued for delivery to ' + cleanNumber
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

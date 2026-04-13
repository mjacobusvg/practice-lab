// netlify/functions/referral-attribution.js
// Handles form submissions from referral-credit.html
// Writes to Supabase referral_attributions table and sends Resend notification

exports.handler = async function(event, context) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { new_member_email, new_member_name, referrer_name, notes } = body;

  if (!new_member_email || !referrer_name) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Email and referrer name are required.' }) };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(new_member_email)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  // Insert into Supabase
  try {
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/referral_attributions`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        new_member_email: new_member_email.trim().toLowerCase(),
        new_member_name: new_member_name ? new_member_name.trim() : null,
        referrer_name: referrer_name.trim(),
        notes: notes ? notes.trim() : null
      })
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('Supabase insert failed:', errText);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not save your submission. Please try again.' }) };
    }

    // Send Resend notification (non-blocking — don't fail the request if email fails)
    if (resendKey) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendKey}`
          },
          body: JSON.stringify({
            from: 'Referral Attribution <noreply@thinkbeyondpractice.com>',
            to: ['michael@thinkbeyondpsych.com'],
            subject: `New referral attribution: ${referrer_name.trim()}`,
            html: `
              <p>A new member submitted a referral attribution:</p>
              <ul>
                <li><strong>New member email:</strong> ${new_member_email.trim().toLowerCase()}</li>
                ${new_member_name ? `<li><strong>New member name:</strong> ${new_member_name.trim()}</li>` : ''}
                <li><strong>Referred by:</strong> ${referrer_name.trim()}</li>
                ${notes ? `<li><strong>Notes:</strong> ${notes.trim()}</li>` : ''}
              </ul>
              <p>Verify on day 16 and process payout in Supabase.</p>
            `
          })
        });
      } catch (emailErr) {
        console.error('Resend email failed (non-blocking):', emailErr);
      }
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };

  } catch (e) {
    console.error('Unexpected error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Unexpected server error.' }) };
  }
};

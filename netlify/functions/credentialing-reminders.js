// netlify/functions/credentialing-reminders.js
// Scheduled function — runs daily to check for 30/60/90 day milestones and CAQH re-attestation
// Deploy with: netlify.toml [functions.credentialing-reminders] schedule = "@daily"

const REMINDER_CONFIGS = [
  {
    field: 'reminder_30_sent',
    days: 30,
    subject: '30-Day Credentialing Follow-Up — {payer}',
    body: `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
      <div style="background:#0b1120;padding:24px 32px;border-radius:8px 8px 0 0">
        <h2 style="color:#2aabb8;margin:0;font-size:20px">Credentialing Hub — 30-Day Follow-Up</h2>
      </div>
      <div style="padding:24px 32px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
        <p>Your credentialing application to <strong>{payer}</strong> was submitted <strong>30 days ago</strong> on {date}.</p>
        <p>Time to check in. Here is what to say:</p>
        <div style="background:#f8f8f8;border-left:4px solid #2aabb8;padding:16px;margin:16px 0;font-size:14px;line-height:1.7">
          <p style="margin:0">"Hi, I am calling to check on the status of a credentialing application I submitted about 30 days ago.</p>
          <p style="margin:8px 0">My name is {name}, NPI {npi}. I submitted through {method} around {date}.</p>
          <p style="margin:0">Can you check where it is in the process and whether anything is needed from me to move it forward?"</p>
        </div>
        <p><strong>Key question to ask:</strong> "Is there anything currently missing or pending on my file that I can provide?"</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Think Beyond Practice — Credentialing Hub</p>
      </div>
    </div>`
  },
  {
    field: 'reminder_60_sent',
    days: 60,
    subject: '60-Day Escalation — {payer} Credentialing',
    body: `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
      <div style="background:#0b1120;padding:24px 32px;border-radius:8px 8px 0 0">
        <h2 style="color:#fbbf24;margin:0;font-size:20px">Credentialing Hub — 60-Day Escalation</h2>
      </div>
      <div style="padding:24px 32px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
        <p>Your credentialing application to <strong>{payer}</strong> has been pending for <strong>60 days</strong> (submitted {date}).</p>
        <p>Time to escalate. Here is what to say:</p>
        <div style="background:#f8f8f8;border-left:4px solid #fbbf24;padding:16px;margin:16px 0;font-size:14px;line-height:1.7">
          <p style="margin:0">"Hi, I am calling regarding a credentialing application submitted over 60 days ago.</p>
          <p style="margin:8px 0">I have checked in previously and want to understand if there are any delays or issues preventing it from moving forward.</p>
          <p style="margin:0">If possible, can this be escalated or flagged for review?"</p>
        </div>
        <p><strong>Key question:</strong> "Is this currently in Primary Source Verification, or has it moved to the Credentialing Committee?"</p>
        <p><strong>If resistance:</strong> "I understand timelines vary. I just want to make sure nothing is missing or holding it up unnecessarily."</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Think Beyond Practice — Credentialing Hub</p>
      </div>
    </div>`
  },
  {
    field: 'reminder_90_sent',
    days: 90,
    subject: 'URGENT: 90-Day Credentialing — {payer}',
    body: `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
      <div style="background:#0b1120;padding:24px 32px;border-radius:8px 8px 0 0">
        <h2 style="color:#f87171;margin:0;font-size:20px">Credentialing Hub — 90-Day Urgency</h2>
      </div>
      <div style="padding:24px 32px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
        <p>Your credentialing application to <strong>{payer}</strong> has been pending for <strong>90 days</strong> (submitted {date}).</p>
        <p>This needs resolution. Here is what to say:</p>
        <div style="background:#f8f8f8;border-left:4px solid #f87171;padding:16px;margin:16px 0;font-size:14px;line-height:1.7">
          <p style="margin:0">"This application is now at the 90-day mark. According to my records, all required information was complete upon submission.</p>
          <p style="margin:8px 0">I need to speak with a Credentialing Coordinator or a Team Lead.</p>
          <p style="margin:0">I am currently unable to bill for your members that I am treating, which is creating a continuity of care issue. I need to know the specific effective date listed in your system, even if the approval letter has not been mailed yet."</p>
        </div>
        <p><strong>Close:</strong> "Is there an email address where I can send a formal inquiry to the Provider Relations Manager for this region?"</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Think Beyond Practice — Credentialing Hub</p>
      </div>
    </div>`
  }
];

exports.handler = async (event) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;

  const supabaseHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };

  try {
    // Fetch all active tracking entries (not approved or denied)
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/credentialing_tracking?status=neq.approved&status=neq.denied&status=neq.withdrawn',
      { headers: supabaseHeaders }
    );
    const entries = await res.json();

    if (!Array.isArray(entries) || entries.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No active entries to check' }) };
    }

    const now = new Date();
    let emailsSent = 0;

    for (const entry of entries) {
      const submitted = new Date(entry.submission_date);
      const daysElapsed = Math.floor((now - submitted) / (1000 * 60 * 60 * 24));

      for (const config of REMINDER_CONFIGS) {
        if (daysElapsed >= config.days && !entry[config.field]) {
          // Send reminder email
          const emailBody = config.body
            .replace(/\{payer\}/g, entry.payer_name)
            .replace(/\{name\}/g, entry.user_name || 'Provider')
            .replace(/\{npi\}/g, entry.npi || '[your NPI]')
            .replace(/\{date\}/g, entry.submission_date)
            .replace(/\{method\}/g, 'CAQH/portal');

          const subject = config.subject
            .replace(/\{payer\}/g, entry.payer_name);

          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + RESEND_KEY
            },
            body: JSON.stringify({
              from: 'Credentialing Hub <onboarding@resend.dev>',
              to: entry.email,
              subject: subject,
              html: emailBody
            })
          });

          // Mark reminder as sent
          const update = {};
          update[config.field] = true;
          update.updated_at = new Date().toISOString();

          await fetch(
            SUPABASE_URL + '/rest/v1/credentialing_tracking?id=eq.' + entry.id,
            {
              method: 'PATCH',
              headers: supabaseHeaders,
              body: JSON.stringify(update)
            }
          );

          emailsSent++;
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Checked ${entries.length} entries, sent ${emailsSent} reminders` })
    };

  } catch (err) {
    console.error('Reminder check error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

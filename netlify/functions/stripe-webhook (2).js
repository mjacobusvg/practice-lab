// netlify/functions/stripe-webhook.js  (practice-lab)
// Handles Stripe checkout.session.completed events for certified-mail jobs ONLY.
// This is the practice-lab site's own webhook, separate from credentialing-hub's.
//
// Flow: create-certified-checkout.js creates a Checkout Session carrying
// certified_mail_job_id in metadata. On completion, this marks the job paid
// and triggers the vendor send (which fails closed if not configured).
//
// Required env (practice-lab Netlify site):
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET   (signing secret for THIS site's webhook endpoint)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
  }

  const session = stripeEvent.data.object;
  const cmJobId = session.metadata && session.metadata.certified_mail_job_id;

  // Not a certified-mail session; ignore.
  if (!cmJobId) {
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, certified_mail: false }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  try {
    await fetch(supabaseUrl + '/rest/v1/certified_mail_jobs?id=eq.' + cmJobId, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        status: 'paid',
        stripe_session_id: session.id,
        amount_paid: session.amount_total || null,
        updated_at: new Date().toISOString()
      })
    });

    try {
      const sender = require('./send-certified-mail.js');
      await sender.submitCertifiedMail(cmJobId);
    } catch (sendErr) {
      console.error('Certified mail send failed for job', cmJobId, sendErr.message);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ received: true, certified_mail_job: cmJobId }) };
  } catch (err) {
    console.error('Certified-mail webhook error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, certified_mail_error: err.message }) };
  }
};

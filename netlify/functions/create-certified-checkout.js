// netlify/functions/create-certified-checkout.js
// BOUND certified-mail payment flow, step 1 of 2.
//
// 1) Receives the rendered letter + addresses from the tool (after the
//    clinician's explicit final-confirmation gate).
// 2) Writes a pending_payment job row to Supabase (the server-side anchor).
// 3) Creates a Stripe Checkout Session for the certified-mail fee, carrying
//    the job id in metadata so the webhook can bind payment -> this exact job.
// 4) Returns the Checkout URL. The browser redirects to Stripe.
//
// FAIL CLOSED: if required config is missing, returns 503 with a clear message
// so the UI shows the manual-tracking fallback instead of a broken send.
//
// Required env:
//   STRIPE_SECRET_KEY
//   STRIPE_CERTIFIED_MAIL_PRICE_ID   (a $15 one-time Price you create in Stripe)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   URL or DEPLOY_PRIME_URL (Netlify provides; used for success/cancel return)
// Optional:
//   CERTIFIED_MAIL_TEST_MODE=true    (marks the job test_mode; vendor send must honor it)

exports.handler = async function(event) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  var stripeKey = process.env.STRIPE_SECRET_KEY;
  var priceId = process.env.STRIPE_CERTIFIED_MAIL_PRICE_ID;
  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  // Fail closed on missing payment/config
  if (!stripeKey || !priceId || !supabaseUrl || !supabaseKey) {
    return {
      statusCode: 503,
      headers: headers,
      body: JSON.stringify({
        error: 'certified_mail_disabled',
        message: 'Certified mail API send is not configured. Use manual certified-mail tracking.'
      })
    };
  }

  try {
    var body = JSON.parse(event.body || '{}');
    var letterText = body.letterText || '';
    if (!letterText || !body.toAddress || !body.fromAddress) {
      return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Missing letter text or addresses.' }) };
    }

    var testMode = process.env.CERTIFIED_MAIL_TEST_MODE === 'true';

    // 1) Write pending job (server-side anchor)
    var jobRes = await fetch(supabaseUrl + '/rest/v1/certified_mail_jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        clinician_email: (body.clinicianEmail || '').toLowerCase().trim() || null,
        letter_text: letterText,
        to_name: body.toName || null,
        to_address: body.toAddress,
        from_name: body.fromName || null,
        from_address: body.fromAddress,
        return_receipt: body.returnReceipt !== false,
        status: 'pending_payment',
        vendor: process.env.CERTIFIED_MAIL_VENDOR || 'postgrid',
        test_mode: testMode
      })
    });
    if (!jobRes.ok) {
      var t = await jobRes.text();
      return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'Could not create mail job: ' + t }) };
    }
    var jobArr = await jobRes.json();
    var job = Array.isArray(jobArr) ? jobArr[0] : jobArr;
    var jobId = job && job.id;
    if (!jobId) return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'No job id returned.' }) };

    // 2) Create Stripe Checkout Session bound to this job
    var stripe = require('stripe')(stripeKey);
    var base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://thinkbeyondpractice.com';
    var session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { certified_mail_job_id: jobId },
      success_url: base + '/termination?cm_job=' + jobId + '&cm_status=paid',
      cancel_url: base + '/termination?cm_job=' + jobId + '&cm_status=canceled',
      customer_email: (body.clinicianEmail || '').toLowerCase().trim() || undefined
    });

    // Store session id on the job for webhook reconciliation
    await fetch(supabaseUrl + '/rest/v1/certified_mail_jobs?id=eq.' + jobId, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': 'Bearer ' + supabaseKey,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ stripe_session_id: session.id, updated_at: new Date().toISOString() })
    }).catch(function(){});

    return { statusCode: 200, headers: headers, body: JSON.stringify({ url: session.url, jobId: jobId }) };

  } catch (err) {
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
  }
};

// netlify/functions/log-view.js
// Records which member opened which page.
// Email comes from the verified token, never from the browser.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, sig] = parts;
  const expected = crypto
    .createHmac('sha256', process.env.SESSION_SIGNING_SECRET)
    .update(payloadB64)
    .digest('base64url');

  if (sig !== expected) return null;

  try {
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (claims.exp && Date.now() / 1000 > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'bad json' };
  }

  const token =
    body.token ||
    (event.headers.authorization || '').replace(/^Bearer\s+/i, '');

  const claims = verifyToken(token);
  if (!claims || !claims.email) {
    return { statusCode: 401, body: 'unauthorized' };
  }

  const path = (body.path || '/').slice(0, 200);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { error } = await supabase.from('page_views').insert({
    email: claims.email,
    path
  });

  if (error) {
    console.error('page_views insert failed:', error.message);
    return { statusCode: 500, body: 'insert failed' };
  }

  return { statusCode: 200, body: 'ok' };
};

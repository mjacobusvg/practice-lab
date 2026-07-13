// netlify/functions/messages.js
// Direct messages between members (member-to-member and member-to-Michael).
// Identity is the signed session token; the account is matched by that email, so
// a member can only send as themselves and only read their own conversations.
// Writes with the service role key (dm_* tables are private: RLS on, no client
// grants). No client ever reads dm_* directly — everything goes through here.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (+ optional SES_* for admin email notify)
// Actions:
//   { token, action:'send', to_id, body }
//   { token, action:'list_conversations' }
//   { token, action:'get_thread', with_id }
//   { token, action:'unread_count' }

const { verifyToken } = require('./_lib/session');
const { emailBcc } = require('./_lib/notify');
const { linkifyMentions } = require('./_lib/mentions');

const MAX_BODY = 5000;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function toHtml(plain) {
  return String(plain).replace(/\r\n/g, '\n').split(/\n{2,}/)
    .map(function (p) { return p.trim(); }).filter(function (p) { return p.length; })
    .map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('\n');
}

// Best-effort email to Michael when he is the recipient, so DMs to him surface.
async function notifyAdmin(fromName, bodyPlain) {
  try {
    const region = process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1';
    const accessKeyId = process.env.SES_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.SES_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) return;
    const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
    const client = new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } });
    const snippet = esc(String(bodyPlain).slice(0, 400));
    await client.send(new SendEmailCommand({
      FromEmailAddress: process.env.SES_FROM || 'Think Beyond Practice <noreply@thinkbeyondpractice.com>',
      Destination: { ToAddresses: [process.env.NOTIFY_TO || 'michael@thinkbeyondpractice.com'] },
      Content: { Simple: {
        Subject: { Data: 'New platform message from ' + fromName, Charset: 'UTF-8' },
        Body: { Html: { Data: '<p><strong>' + esc(fromName) + '</strong> sent you a message on the platform:</p><blockquote>' + snippet + '</blockquote><p>Reply from the platform Messages.</p>', Charset: 'UTF-8' } }
      } }
    }));
  } catch (e) { /* best-effort */ }
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !KEY) return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }) };

  const sbHeaders = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
  const sb = async (path, method, body, prefer) => {
    const h = prefer ? Object.assign({}, sbHeaders, { 'Prefer': prefer }) : sbHeaders;
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + text.slice(0, 200));
    return text ? JSON.parse(text) : null;
  };

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) }; }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const sessionToken = (p.token || authHeader.replace(/^Bearer\s+/i, '')).trim();
  const session = verifyToken(sessionToken);
  if (!session.valid) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };
  if (session.claims.scope !== 'member') return { statusCode: 403, headers, body: JSON.stringify({ ok: false, error: 'Members only' }) };
  const email = String(session.claims.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: 'Sign in first' }) };

  try {
    const meRows = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id,name,avatar_url,is_admin&limit=1', 'GET');
    if (!meRows || !meRows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'No account found.' }) };
    const me = meRows[0];

    // Canonical pair helpers (uuid string order matches Postgres uuid order).
    const pairFilter = function (a, b) {
      const lo = a < b ? a : b, hi = a < b ? b : a;
      return { lo: lo, hi: hi };
    };

    if (p.action === 'send') {
      const toId = String(p.to_id || '').trim();
      const raw = String(p.body || '').trim();
      if (!toId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Recipient required' }) };
      if (toId === me.id) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'You cannot message yourself' }) };
      if (!raw) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Message is empty' }) };
      if (raw.length > MAX_BODY) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Message is too long' }) };

      const recRows = await sb('accounts?id=eq.' + encodeURIComponent(toId) + '&select=id,name,is_admin,email,notify_email_dms&limit=1', 'GET');
      if (!recRows || !recRows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Recipient not found' }) };
      const rec = recRows[0];

      const pr = pairFilter(me.id, toId);
      let convs = await sb('dm_conversations?user_a=eq.' + pr.lo + '&user_b=eq.' + pr.hi + '&select=id&limit=1', 'GET');
      let convId;
      if (convs && convs.length) {
        convId = convs[0].id;
      } else {
        const created = await sb('dm_conversations', 'POST', { user_a: pr.lo, user_b: pr.hi, created_at: new Date().toISOString() });
        convId = created[0].id;
      }

      const preview = raw.replace(/\s+/g, ' ').slice(0, 140);
      // In a 1:1 DM the only mentionable person is the recipient; linkify their
      // name for visual consistency (no extra notification — they get the DM).
      const dmBodyHtml = linkifyMentions(toHtml(raw), [{ id: rec.id, name: rec.name }]);
      const inserted = await sb('dm_messages', 'POST', {
        conversation_id: convId, sender_id: me.id, recipient_id: toId,
        body_plain: raw, body_html: dmBodyHtml
      });
      const msg = inserted[0];

      await sb('dm_conversations?id=eq.' + convId, 'PATCH', {
        last_message_at: msg.created_at, last_message_preview: preview, last_sender_id: me.id
      }, 'return=minimal');

      // Email the recipient if they opted in (best-effort; never blocks send).
      if (rec.notify_email_dms && rec.email) {
        try {
          var dmHtml = '<p><strong>' + esc(me.name || 'A member') + '</strong> sent you a message on Think Beyond Practice:</p>' +
            '<blockquote>' + esc(String(raw).slice(0, 400)) + '</blockquote>' +
            '<p><a href="https://thinkbeyondpractice.com/platform.html">Reply on the platform &rarr;</a></p>' +
            '<p style="font-size:12px;color:#888">Manage email notifications in your profile.</p>';
          await emailBcc([rec.email], 'New message from ' + (me.name || 'a member'), dmHtml);
        } catch (e) { /* best-effort */ }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: {
        id: msg.id, conversation_id: convId, sender_id: me.id, recipient_id: toId,
        body_html: msg.body_html, created_at: msg.created_at
      } }) };
    }

    if (p.action === 'list_conversations') {
      const convs = await sb('dm_conversations?or=(user_a.eq.' + me.id + ',user_b.eq.' + me.id + ')&order=last_message_at.desc.nullslast&limit=200', 'GET');
      if (!convs || !convs.length) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, conversations: [] }) };

      // Other participants' display info (one batched query).
      const otherIds = convs.map(function (c) { return c.user_a === me.id ? c.user_b : c.user_a; });
      const uniqueIds = otherIds.filter(function (v, i, a) { return a.indexOf(v) === i; });
      const others = await sb('accounts?id=in.(' + uniqueIds.join(',') + ')&select=id,name,avatar_url', 'GET');
      const byId = {}; (others || []).forEach(function (o) { byId[o.id] = o; });

      // My unread messages (small set), tallied per conversation.
      const unreadRows = await sb('dm_messages?recipient_id=eq.' + me.id + '&read_at=is.null&select=conversation_id', 'GET');
      const unreadByConv = {}; (unreadRows || []).forEach(function (r) { unreadByConv[r.conversation_id] = (unreadByConv[r.conversation_id] || 0) + 1; });

      const conversations = convs.map(function (c) {
        const otherId = c.user_a === me.id ? c.user_b : c.user_a;
        const o = byId[otherId] || { id: otherId, name: 'Member', avatar_url: null };
        return {
          conversation_id: c.id, other: { id: o.id, name: o.name, avatar_url: o.avatar_url },
          last_message_preview: c.last_message_preview, last_message_at: c.last_message_at,
          last_sender_id: c.last_sender_id, unread: unreadByConv[c.id] || 0
        };
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, conversations: conversations }) };
    }

    if (p.action === 'get_thread') {
      const withId = String(p.with_id || '').trim();
      if (!withId) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'with_id required' }) };
      const otherRows = await sb('accounts?id=eq.' + encodeURIComponent(withId) + '&select=id,name,avatar_url,credentials&limit=1', 'GET');
      if (!otherRows || !otherRows.length) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'Member not found' }) };
      const other = otherRows[0];

      const pr = pairFilter(me.id, withId);
      const convs = await sb('dm_conversations?user_a=eq.' + pr.lo + '&user_b=eq.' + pr.hi + '&select=id&limit=1', 'GET');
      if (!convs || !convs.length) {
        // No thread yet — valid empty state (compose will create it on first send).
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, other: other, messages: [] }) };
      }
      const convId = convs[0].id;
      const messages = await sb('dm_messages?conversation_id=eq.' + convId + '&order=created_at.asc&limit=500&select=id,sender_id,recipient_id,body_html,created_at', 'GET');

      // Mark messages TO me as read.
      await sb('dm_messages?conversation_id=eq.' + convId + '&recipient_id=eq.' + me.id + '&read_at=is.null', 'PATCH', { read_at: new Date().toISOString() }, 'return=minimal');

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, conversation_id: convId, other: other, messages: messages || [] }) };
    }

    if (p.action === 'unread_count') {
      const res = await fetch(SUPABASE_URL + '/rest/v1/dm_messages?recipient_id=eq.' + me.id + '&read_at=is.null&select=id',
        { headers: Object.assign({}, sbHeaders, { 'Prefer': 'count=exact', 'Range': '0-0' }) });
      const cr = res.headers.get('content-range') || '';
      const total = parseInt((cr.split('/')[1] || '0'), 10) || 0;
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: total }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

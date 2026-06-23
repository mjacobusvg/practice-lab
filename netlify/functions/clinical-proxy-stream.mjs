//.netlify/functions/clinical-proxy-stream.mjs
// Dedicated STREAMING Anthropic proxy for PHI-handling clinical tools
// (Chart Coder, Letter Generator, Interaction Checker, etc.).
//
// Uses Netlify's modern streaming function API: returns a Response whose body
// is a ReadableStream. Anthropic is called with stream:true, and its SSE bytes
// are passed straight through to the browser as they arrive. Because bytes flow
// continuously, the function never trips Netlify's idle/inactivity timeout that
// kills a blocking (buffered) proxy on slow generations.
//
// Does NOT log message content. Covered by the Anthropic API BAA.
//
// Request body: raw Anthropic /v1/messages payload { model, max_tokens, system?, messages, tools? }
// Response: text/event-stream (Anthropic SSE passed through verbatim). The
// browser is responsible for reassembling the text from content_block_delta events.

export default async function handler(request) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: cors });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured.' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  let body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  const payload = {
    model: body.model || 'claude-haiku-4-5-20251001',
    max_tokens: body.max_tokens || 1000,
    system: body.system || '',
    messages: body.messages || [],
    stream: true
  };
  if (body.tools && Array.isArray(body.tools)) payload.tools = body.tools;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(JSON.stringify({ error: 'Anthropic API error ' + upstream.status + ': ' + errText.substring(0, 300) }), {
      status: 502, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }

  // Pass the Anthropic SSE stream straight through to the browser.
  // Bytes flow continuously, so the idle timeout never fires.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    }
  });
}

export const config = { path: '/.netlify/functions/clinical-proxy-stream' };

// netlify/functions/ask-archive.js
// RAG query function for Ask the Archive
// 1. Embeds member question via OpenAI
// 2. Runs vector similarity search against Supabase posts table
// 3. Enriches comment chunks with parent post context
// 4. Sends full context + question to Claude for synthesis
// 5. Returns { answer, sources } or { unanswered: true } if no match found
// 6. Logs unanswered questions to Supabase and emails michael@thinkbeyondpsych.com

const MATCH_THRESHOLD = 0.45;
const BROWSE_THRESHOLD = 0.38;
const MATCH_COUNT = 12;

// Patterns that indicate a browse/meta question rather than a clinical question
const META_PATTERNS = [
  /^are there (any )?posts? on /i,
  /^do you have (anything|any posts?) (on|about) /i,
  /^what (do you have|posts?) (on|about) /i,
  /^is there anything (on|about) /i,
  /^what topics? (cover|cover|address|discuss) /i,
  /^show me (posts?|anything) (on|about) /i,
  /^find (posts?|anything) (on|about) /i,
  /^(search|look) for (posts?|anything) (on|about) /i,
  /^any posts? (on|about) /i,
  /^(what|anything) (in the archive|available) (on|about) /i
];

// Extract the core topic from a meta question for better embedding
function extractTopic(question) {
  return question
    .replace(/^are there (any )?posts? on /i, '')
    .replace(/^do you have (anything|any posts?) (on|about) /i, '')
    .replace(/^what (do you have|posts?) (on|about) /i, '')
    .replace(/^is there anything (on|about) /i, '')
    .replace(/^what topics? (cover|address|discuss) /i, '')
    .replace(/^show me (posts?|anything) (on|about) /i, '')
    .replace(/^find (posts?|anything) (on|about) /i, '')
    .replace(/^(search|look) for (posts?|anything) (on|about) /i, '')
    .replace(/^any posts? (on|about) /i, '')
    .replace(/^(what|anything) (in the archive|available) (on|about) /i, '')
    .trim();
}

function isMetaQuestion(question) {
  return META_PATTERNS.some(function(p) { return p.test(question); });
}

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
  try { body = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const question = (body.question || '').trim();
  const memberRequested = body.member_requested === true;
  const requestTemplate = body.request_template === true;
  const conversationHistory = body.conversation_history || [];

  if (!question) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Question required' }) };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseKey || !openaiKey || !anthropicKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  // ── Template request path ────────────────────────────────────────────────
  if (requestTemplate) {
    await logTemplateRequest(supabaseUrl, supabaseKey, question);
    await sendTemplateRequestEmail(resendKey, question);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, message: 'Template request submitted.' })
    };
  }

  try {
    // ── Step 1: Query expansion + embedding (skip for meta/browse questions) ──
    let matches;

    if (isMetaQuestion(question)) {
      // ── Full-text keyword search for browse/meta questions ─────────────────
      const topic = extractTopic(question);
      console.log('FTS topic:', topic);

      const ftsRes = await fetch(`${supabaseUrl}/rest/v1/rpc/search_posts_fts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        },
        body: JSON.stringify({
          search_query: topic,
          match_count: 20
        })
      });

      if (!ftsRes.ok) {
        const err = await ftsRes.text();
        console.log('FTS error:', err.substring(0, 200));
        matches = [];
      } else {
        matches = await ftsRes.json();
        console.log('FTS matches:', matches.length);
      }

    } else {
      // ── Query expansion for clinical questions ─────────────────────────────
      // Generate 3 semantic variants of the question so we catch content that
      // uses different terminology than the member's phrasing
      const expansionRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `You are helping search a psychiatric prescriber forum. Given this question: "${question}"

Generate 3 alternative phrasings that capture the same clinical concept but use different terminology an expert might use when writing about this topic. Think about how the answer would be written, not how the question is asked.

Important: For any billing or E/M coding question, always include one variant covering time-based billing and one covering MDM-based billing, since both are valid paths.

Return only a JSON array of 3 strings. No preamble, no explanation. Example format: ["phrase 1", "phrase 2", "phrase 3"]`
          }]
        })
      });

      let queryVariants = [question];
      if (expansionRes.ok) {
        try {
          const expansionData = await expansionRes.json();
          const expansionText = expansionData.content[0].text.replace(/```json|```/g, '').trim();
          const variants = JSON.parse(expansionText);
          if (Array.isArray(variants)) {
            queryVariants = [question, ...variants].slice(0, 4);
          }
        } catch(e) {
          console.log('Query expansion parse error:', e.message);
        }
      }

      console.log('Query variants:', queryVariants);

      // Embed all variants in parallel
      const embeddings = await Promise.all(
        queryVariants.map(function(q) { return getEmbedding(q, openaiKey); })
      );

      // Run vector search for each embedding in parallel
      const searchResults = await Promise.all(
        embeddings.map(function(emb) {
          return fetch(`${supabaseUrl}/rest/v1/rpc/match_posts`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`
            },
            body: JSON.stringify({
              query_embedding: emb,
              match_threshold: MATCH_THRESHOLD,
              match_count: MATCH_COUNT
            })
          }).then(function(r) { return r.ok ? r.json() : []; });
        })
      );

      // Merge results — dedupe by id, keep highest similarity score per record
      const mergedMap = {};
      searchResults.forEach(function(resultSet) {
        (resultSet || []).forEach(function(record) {
          if (!mergedMap[record.id] || (record.similarity > mergedMap[record.id].similarity)) {
            mergedMap[record.id] = record;
          }
        });
      });

      // Sort by similarity descending, take top MATCH_COUNT
      matches = Object.values(mergedMap)
        .sort(function(a, b) { return (b.similarity || 0) - (a.similarity || 0); })
        .slice(0, MATCH_COUNT);

      console.log('Expanded search matches:', matches.length, 'from', queryVariants.length, 'variants');

      // ── Parallel template search ─────────────────────────────────────────
      // Always search for template/macro posts related to the topic so they
      // appear in context even if their vector score didn't rank them highly
      const templateSearchRes = await fetch(`${supabaseUrl}/rest/v1/rpc/search_posts_fts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        },
        body: JSON.stringify({
          search_query: queryVariants[0].replace(/^(what|how|when|why|can|is|are|do|does)\s+/i, '').substring(0, 60),
          match_count: 8
        })
      });

      if (templateSearchRes.ok) {
        const templateMatches = await templateSearchRes.json();
        const TEMPLATE_KEYWORDS = ['template', 'macro', 'phrasing', 'dotphrase', 'snippet', 'language', 'documentation'];
        const templatePosts = templateMatches.filter(function(m) {
          const titleLower = (m.title || '').toLowerCase();
          return TEMPLATE_KEYWORDS.some(function(kw) { return titleLower.includes(kw); });
        });

        // Add template posts to matches if not already present
        const existingIds = new Set(matches.map(function(m) { return m.id; }));
        templatePosts.forEach(function(tp) {
          if (!existingIds.has(tp.id)) {
            tp._isTemplateCandidate = true;
            matches.push(tp);
          }
        });

        console.log('Template candidates added:', templatePosts.filter(function(tp) {
          return !existingIds.has(tp.id);
        }).length);
      }
    }

    // ── Step 2: Handle meta/browse questions ────────────────────────────────
    if (isMetaQuestion(question)) {

      // Filter out housekeeping/announcement spaces that aren't content posts
      const EXCLUDED_BROWSE_SPACES = [
        'start here',
        'forum updates',
        'forum updates & announcements',
        'welcome',
        'announcements'
      ];

      const filteredMatches = (matches || []).filter(function(m) {
        const spaceLower = (m.space_name || '').toLowerCase();
        return !EXCLUDED_BROWSE_SPACES.some(function(ex) {
          return spaceLower.includes(ex);
        });
      });

      if (filteredMatches.length === 0) {
        return {
          statusCode: 200,
          headers: CORS,
          body: JSON.stringify({
            browse: true,
            topic: question,
            posts: [],
            total: 0,
            related_topics: []
          })
        };
      }

      // Sort: full posts first, comments second
      const sortedMatches = filteredMatches.slice().sort(function(a, b) {
        var aIsComment = (a.id || '').startsWith('comment_') ? 1 : 0;
        var bIsComment = (b.id || '').startsWith('comment_') ? 1 : 0;
        return aIsComment - bIsComment;
      });

      // Dedupe by URL and filter redundant comments first
      const seenBrowse = new Set();
      const seenTitles = new Set();

      // First pass: collect full post titles
      sortedMatches.forEach(function(m) {
        if (!(m.id || '').startsWith('comment_') && m.url) {
          seenTitles.add((m.title || '').trim());
        }
      });

      const dedupedMatches = sortedMatches
        .filter(function(m) { return m.url; })
        .filter(function(m) {
          if (seenBrowse.has(m.url)) return false;
          seenBrowse.add(m.url);
          return true;
        })
        .filter(function(m) {
          // Filter out comments whose parent post is already in results
          if ((m.id || '').startsWith('comment_') && (m.title || '').startsWith('Comment on: ')) {
            const parentTitle = m.title.replace(/^Comment on:\s*/i, '').trim();
            if (seenTitles.has(parentTitle)) return false;
          }
          return true;
        });

      const totalPosts = dedupedMatches.length;
      const page = parseInt(body.page || 1);
      const pageSize = 10;
      const start = (page - 1) * pageSize;
      const pagePosts = dedupedMatches.slice(start, start + pageSize);

      // Ask Claude to generate descriptions and related topics for this page
      const browseContext = pagePosts.map(function(m, i) {
        return `[${i+1}] Title: ${m.title}\nSpace: ${m.space_name}\nContent: ${(m.body || '').substring(0, 300)}`;
      }).join('\n\n');

      const browseRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 700,
          messages: [{
            role: 'user',
            content: `Given these forum posts related to "${extractTopic(question)}":\n\n${browseContext}\n\nReturn JSON with two fields:\n1. "post_descriptions": array of { "index": number, "description": "one sentence max 15 words describing what this post covers" }\n2. "related_topics": array of 3-5 short topic strings (2-5 words each) that are adjacent or related and would make good follow-up searches. Only include on page 1.\n\nReturn only valid JSON, no preamble.`
          }]
        })
      });

      let relatedTopics = [];
      let postDescMap = {};
      if (browseRes.ok) {
        try {
          const browseData = await browseRes.json();
          const browseText = browseData.content[0].text.replace(/```json|```/g, '').trim();
          const browseParsed = JSON.parse(browseText);
          if (page === 1) relatedTopics = browseParsed.related_topics || [];
          (browseParsed.post_descriptions || []).forEach(function(d) {
            const match = pagePosts[d.index - 1];
            if (match && match.url) {
              postDescMap[match.url] = d.description;
            }
          });
        } catch(e) {
          console.log('Browse parse error:', e.message);
        }
      }

      const browsePosts = pagePosts.map(function(m) {
        return {
          title: m.title,
          space: m.space_name,
          author: m.author,
          url: m.url,
          description: postDescMap[m.url] || ''
        };
      });

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          browse: true,
          topic: question,
          posts: browsePosts,
          total: totalPosts,
          page: page,
          has_more: (start + pageSize) < totalPosts,
          related_topics: relatedTopics
        })
      };
    }

    // ── Step 4: Handle unanswered ───────────────────────────────────────────
    if (!matches || matches.length === 0) {
      await logUnanswered(supabaseUrl, supabaseKey, question, memberRequested);
      await sendUnansweredEmail(resendKey, question);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          unanswered: true,
          answer: "The archive doesn't have a strong match for this question yet. It's been logged and Michael will be notified."
        })
      };
    }

    // ── Step 4: Enrich comment chunks with parent post context (parallel) ────
    const enrichedChunks = await enrichCommentChunksParallel(matches, supabaseUrl, supabaseKey);

    // ── Step 4b: Gap detection with time budget ──────────────────────────────
    // Only run if we have budget — skip if already took too long
    const startTime = Date.now();
    const TIME_BUDGET_MS = 6000; // Leave room for synthesis within 10s total

    if (Date.now() - startTime < TIME_BUDGET_MS) {
      const retrievedTitles = enrichedChunks.map(function(c) { return c.title; }).join('\n');

      try {
        const gapRes = await Promise.race([
          fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 100,
              messages: [{
                role: 'user',
                content: `A member asked: "${question}"

Retrieved posts:
${retrievedTitles}

List up to 2 critical topic angles MISSING from these posts needed for a complete answer. Return ONLY a JSON array of short search phrases (3-5 words each), or [] if nothing is missing. No explanation.`
              }]
            })
          }),
          new Promise(function(_, reject) { setTimeout(function() { reject(new Error('gap timeout')); }, 2500); })
        ]);

        if (gapRes.ok) {
          const gapData = await gapRes.json();
          const gapText = gapData.content[0].text.replace(/```json|```/g, '').trim();
          const gapPhrases = JSON.parse(gapText);

          if (Array.isArray(gapPhrases) && gapPhrases.length > 0) {
            const existingIds = new Set(enrichedChunks.map(function(c) { return c.id; }));

            // Run gap searches in parallel
            const gapSearches = await Promise.all(
              gapPhrases.map(async function(phrase) {
                try {
                  const gapEmbedding = await getEmbedding(phrase, openaiKey);
                  const gapSearchRes = await fetch(`${supabaseUrl}/rest/v1/rpc/match_posts`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'apikey': supabaseKey,
                      'Authorization': `Bearer ${supabaseKey}`
                    },
                    body: JSON.stringify({
                      query_embedding: gapEmbedding,
                      match_threshold: MATCH_THRESHOLD,
                      match_count: 4
                    })
                  });
                  return gapSearchRes.ok ? await gapSearchRes.json() : [];
                } catch(e) { return []; }
              })
            );

            gapSearches.forEach(function(results) {
              results.forEach(function(m) {
                if (!existingIds.has(m.id) && m.url) {
                  existingIds.add(m.id);
                  enrichedChunks.push(m);
                }
              });
            });
          }
        }
      } catch(ge) {
        console.log('Gap detection skipped:', ge.message);
      }
    }

    // ── Step 5: Build context for Claude ────────────────────────────────────
    const contextBlocks = enrichedChunks.map(function(chunk, i) {
      const templateFlag = chunk._isTemplateCandidate ? '\n[NOTE: This post contains templates or macros]' : '';
      return `[Source ${i + 1}]\nTitle: ${chunk.title}\nSpace: ${chunk.space_name}\nAuthor: ${chunk.author}\nURL: ${chunk.url}${templateFlag}\n\n${chunk.body}`;
    }).join('\n\n---\n\n');

    // ── Step 6: Build messages for Claude ───────────────────────────────────
    const systemPrompt = `You are Ask the Archive, a tool that answers clinical, billing, and practice management questions for psychiatric prescribers using content from the Think Beyond Practice forum written by Michael Van Gelder, PMHNP-BC.

FIRST: Assess whether the retrieved sources actually address the question asked.

If the sources do NOT address the question — for any reason — return:
{ "status": "unanswered" }

If the sources DO address the question, return status "answered" with the full structured response.

Format answered responses in exactly this structure:

1. What to do — one direct, actionable sentence that answers the question immediately. No preamble, no setup, no "it depends." If there are multiple components, they go in Required elements — do NOT embed them in this sentence.

2. Required elements — when the answer involves specific components, document them as a clean line-item list. Each item on its own line. Never fold these into a paragraph.

3. Critical rule — one line only. Include ONLY when the source content contains a hard rule clinicians commonly violate or get wrong. Skip entirely if no such rule exists in the retrieved content.

4. Example — pulled directly from the language in the source posts. Include only when present in retrieved content — do not generate. Keep it to 2-3 lines maximum.

5. Common mistake — one line identifying the most frequent error. Include only when present in retrieved content.

Keep the answer section under 200 words. Prioritize the most actionable elements and leave depth to the source links.

MEDICATION ACCURACY RULE: When the answer involves specific medications, only include clinical details (dosing, monitoring frequencies, lab values, target levels, timing) that are explicitly stated in the retrieved sources AND apply to the specific medication being asked about. Never blend monitoring requirements, dosing schedules, or lab targets from one medication into an answer about a different medication. Never include situational or optional labs (such as B12, vitamin D, magnesium, or folate) in medication-specific monitoring answers unless the retrieved source explicitly lists them as required for that specific medication. When in doubt about whether a specific clinical detail applies to the medication in question, omit it rather than include it.

Do NOT open with explanation or context. The first sentence must be the answer.
Do NOT include a "Go deeper in these posts" line or any source references in the answer text. Sources are rendered separately by the UI.

CRITICAL: Your entire response must be valid JSON. Start with { and end with }. Nothing outside the JSON object.

For answered questions:
{
  "status": "answered",
  "answer": "the full answer text following the structure above",
  "source_descriptions": [
    { "index": 1, "description": "one-line max 12 words describing what this source covers" }
  ],
  "template_sources": [
    { "index": 1, "template_description": "one-line description of what template this source contains" }
  ]
}

Include one entry in source_descriptions for EVERY source without exception. Count your sources first, then ensure your source_descriptions array has exactly that same number of entries. Every single source must have a description — no source may be left without one. If a source is a comment with no clear topic, describe what clinical issue it addresses based on its content. Keep each to 12 words or fewer. Missing even one description is a failure.
For template_sources: only include sources with actual usable templates, sample language, macros, or downloadable documents. Sources flagged with [NOTE: This post contains templates or macros] should be prioritized. Return empty array if none.
Return ONLY the JSON object. Nothing before or after it.`;

    const userMessage = `Forum sources:\n\n${contextBlocks}\n\n---\n\nQuestion: ${question}`;

    // Build messages array including conversation history for follow-up support
    const messages = [];
    conversationHistory.forEach(function(turn) {
      messages.push(turn);
    });
    messages.push({ role: 'user', content: userMessage });

    // ── Step 7: Claude synthesis ─────────────────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3500,
        system: systemPrompt,
        messages: messages
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.log('Claude error:', err.substring(0, 200));
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Synthesis failed' }) };
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content[0].text;

    let parsed;
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch(e) {
      console.log('JSON parse error:', e.message, 'Raw:', rawText.substring(0, 300));
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Response parse failed' }) };
    }

    // ── Handle three response states ─────────────────────────────────────────
    if (parsed.status === 'unanswered') {
      await logUnanswered(supabaseUrl, supabaseKey, question, memberRequested);
      await sendUnansweredEmail(resendKey, question);
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          unanswered: true,
          answer: "The archive doesn't have content on this topic yet. It's been logged and Michael will be notified."
        })
      };
    }

    // ── Step 8: Build source list with descriptions ──────────────────────────
    const sourceDescMap = {};
    (parsed.source_descriptions || []).forEach(function(s) {
      sourceDescMap[s.index] = s.description;
    });

    const sources = enrichedChunks.map(function(chunk, i) {
      return {
        title: chunk.title,
        space: chunk.space_name,
        author: chunk.author,
        url: chunk.url,
        description: sourceDescMap[i + 1] || ''
      };
    }).filter(function(s) { return s.url; });

    // Dedupe by URL — prefer entry with description over entry without
    const urlMap = {};
    sources.forEach(function(s) {
      if (!urlMap[s.url] || (!urlMap[s.url].description && s.description)) {
        urlMap[s.url] = s;
      }
    });
    const dedupedSources = Object.values(urlMap);

    // ── Step 9: Build template sources list ──────────────────────────────────
    const templateSourceIndexes = new Set(
      (parsed.template_sources || []).map(function(t) { return t.index; })
    );
    const templateDescMap = {};
    (parsed.template_sources || []).forEach(function(t) {
      templateDescMap[t.index] = t.template_description;
    });

    const templateSourcesRaw = enrichedChunks
      .map(function(chunk, i) {
        if (!templateSourceIndexes.has(i + 1)) return null;
        return {
          title: chunk.title,
          space: chunk.space_name,
          author: chunk.author,
          url: chunk.url,
          template_description: templateDescMap[i + 1] || ''
        };
      })
      .filter(Boolean)
      .filter(function(s) { return s.url; });

    // Dedupe template sources by URL
    const seenTemplates = new Set();
    const templateSources = templateSourcesRaw.filter(function(s) {
      if (seenTemplates.has(s.url)) return false;
      seenTemplates.add(s.url);
      return true;
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        answer: parsed.answer,
        sources: dedupedSources,
        template_sources: templateSources,
        unanswered: false
      })
    };

  } catch(err) {
    console.log('ask-archive fatal error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error: ' + err.message }) };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getEmbedding(text, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.substring(0, 8000),
      dimensions: 1536
    })
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('OpenAI embedding failed: ' + err.substring(0, 200));
  }
  const data = await resp.json();
  return data.data[0].embedding;
}

async function enrichCommentChunksParallel(matches, supabaseUrl, supabaseKey) {
  // Process all chunks in parallel instead of sequentially
  const results = await Promise.all(matches.map(async function(chunk) {
    if (chunk.id && chunk.id.startsWith('comment_') && chunk.circle_post_id) {
      try {
        const parentRes = await fetch(
          `${supabaseUrl}/rest/v1/posts?id=eq.post_${chunk.circle_post_id}&select=title,body,url,space_name,author&limit=1`,
          { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } }
        );
        if (parentRes.ok) {
          const parentData = await parentRes.json();
          if (parentData.length > 0) {
            const parent = parentData[0];
            return {
              ...chunk,
              title: chunk.title || parent.title,
              url: chunk.url || parent.url,
              space_name: chunk.space_name || parent.space_name,
              author: chunk.author || parent.author,
              body: `[From post: ${parent.title}]\n\n${chunk.body}`
            };
          }
        }
      } catch(e) {
        console.log('Parent fetch error for', chunk.id, e.message);
      }
    }
    return chunk;
  }));
  return results;
}

async function enrichCommentChunks(matches, supabaseUrl, supabaseKey) {
  const enriched = [];
  for (const chunk of matches) {
    // If this is a comment chunk, fetch the parent post for context
    if (chunk.id && chunk.id.startsWith('comment_') && chunk.circle_post_id) {
      try {
        const parentRes = await fetch(
          `${supabaseUrl}/rest/v1/posts?id=eq.post_${chunk.circle_post_id}&select=title,body,url,space_name,author&limit=1`,
          {
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`
            }
          }
        );
        if (parentRes.ok) {
          const parentData = await parentRes.json();
          if (parentData.length > 0) {
            const parent = parentData[0];
            enriched.push({
              ...chunk,
              title: chunk.title || parent.title,
              url: chunk.url || parent.url,
              space_name: chunk.space_name || parent.space_name,
              author: chunk.author || parent.author,
              body: `[From post: ${parent.title}]\n\n${chunk.body}`
            });
            continue;
          }
        }
      } catch(e) {
        console.log('Parent fetch error for', chunk.id, e.message);
      }
    }
    enriched.push(chunk);
  }
  return enriched;
}

async function logUnanswered(supabaseUrl, supabaseKey, question, memberRequested) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/unanswered_questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        question: question,
        member_requested: memberRequested,
        created_at: new Date().toISOString()
      })
    });
  } catch(e) {
    console.log('logUnanswered error:', e.message);
  }
}

async function sendUnansweredEmail(resendKey, question) {
  if (!resendKey) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'Ask the Archive <noreply@thinkbeyondpractice.com>',
        to: ['michael@thinkbeyondpsych.com'],
        subject: 'Ask the Archive — Unanswered Question',
        html: `<p>A member asked a question the archive couldn't answer:</p><blockquote>${question}</blockquote><p>To review all unanswered questions, run:<br><code>select question, member_requested, created_at from unanswered_questions order by created_at desc;</code></p>`
      })
    });
  } catch(e) {
    console.log('sendUnansweredEmail error:', e.message);
  }
}

async function logTemplateRequest(supabaseUrl, supabaseKey, question) {
  if (!supabaseUrl || !supabaseKey) return;
  try {
    await fetch(`${supabaseUrl}/rest/v1/unanswered_questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        question: `[TEMPLATE REQUEST] ${question}`,
        member_requested: true,
        created_at: new Date().toISOString()
      })
    });
  } catch(e) {
    console.log('logTemplateRequest error:', e.message);
  }
}

async function sendTemplateRequestEmail(resendKey, question) {
  if (!resendKey) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'Ask the Archive <noreply@thinkbeyondpractice.com>',
        to: ['michael@thinkbeyondpsych.com'],
        subject: 'Ask the Archive — Template Request',
        html: `<p>A member requested a template for:</p><blockquote>${question}</blockquote><p>Consider creating a post with a template for this topic.</p>`
      })
    });
  } catch(e) {
    console.log('sendTemplateRequestEmail error:', e.message);
  }
}

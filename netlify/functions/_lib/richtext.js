// netlify/functions/_lib/richtext.js
//
// Member-safe rich text: a small, deliberately limited Markdown renderer used
// for post and comment bodies. platform.html renders the resulting body_html via
// innerHTML, so safety is non-negotiable and works by construction:
//
//   1. Every line is HTML-ESCAPED FIRST. No member-supplied tag ever survives,
//      because '<' and '>' and '"' are gone before any markup is added.
//   2. Only a fixed allowlist of block/inline constructs is then re-introduced
//      (headings, bold, italic, code, lists, quote, divider, links, line breaks).
//   3. Links accept http(s)/mailto only; anything else renders as plain text, so
//      no javascript: or data: URLs reach an href.
//
// The raw source (the member's Markdown) is stored separately as body_plain, so
// editing/round-tripping keeps the original text.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Inline formatting on already-escaped text. Order matters: code first (so its
// contents are not re-processed), then bold, italic, then links.
function inline(text) {
  var out = text;
  out = out.replace(/`([^`\n]+)`/g, function (m, c) { return '<code>' + c + '</code>'; });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  // [text](url) — http(s) or mailto only; otherwise leave the literal text.
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, function (m, txt, url) {
    return '<a href="' + url + '" target="_blank" rel="noopener nofollow">' + txt + '</a>';
  });
  return out;
}

function toRichHtml(src) {
  var lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var out = [];
  var para = [];
  var listType = null;   // 'ul' | 'ol'
  var listItems = [];
  var quote = [];

  function flushPara() { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } }
  function flushList() { if (listType) { out.push('<' + listType + '>' + listItems.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</' + listType + '>'); listType = null; listItems = []; } }
  function flushQuote() { if (quote.length) { out.push('<blockquote>' + quote.join('<br>') + '</blockquote>'); quote = []; } }
  function flushAll() { flushPara(); flushList(); flushQuote(); }

  lines.forEach(function (line) {
    var e = esc(line);
    var trimmed = e.trim();

    if (trimmed === '') { flushAll(); return; }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushAll(); out.push('<hr>'); return; }

    // Heading (# .. ###  ->  h2 .. h4, since h1 is the page/post title).
    var hm = /^(#{1,3})\s+(.*)$/.exec(e);
    if (hm) { flushAll(); var lvl = hm[1].length + 1; out.push('<h' + lvl + '>' + inline(hm[2].trim()) + '</h' + lvl + '>'); return; }

    // Blockquote ('>' was escaped to '&gt;').
    var qm = /^&gt;\s?(.*)$/.exec(e);
    if (qm) { flushPara(); flushList(); quote.push(inline(qm[1])); return; }

    // Unordered list item.
    var um = /^[-*]\s+(.*)$/.exec(trimmed);
    if (um) { flushPara(); flushQuote(); if (listType && listType !== 'ul') flushList(); listType = 'ul'; listItems.push(inline(um[1])); return; }

    // Ordered list item.
    var om = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (om) { flushPara(); flushQuote(); if (listType && listType !== 'ol') flushList(); listType = 'ol'; listItems.push(inline(om[1])); return; }

    // Plain paragraph line.
    flushList(); flushQuote();
    para.push(inline(e));
  });

  flushAll();
  return out.join('\n');
}

module.exports = { toRichHtml, esc };

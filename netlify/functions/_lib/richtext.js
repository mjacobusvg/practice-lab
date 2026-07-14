// netlify/functions/_lib/richtext.js
//
// Member-safe rich text: a small, deliberately limited Markdown renderer used
// for post and comment bodies. platform.html renders the resulting body_html via
// innerHTML, so safety is non-negotiable and works by construction:
//
//   1. Every line is HTML-ESCAPED FIRST. No member-supplied tag ever survives,
//      because '<' and '>' and '"' are gone before any markup is added.
//   2. Only a fixed allowlist of block/inline constructs is then re-introduced
//      (headings, bold, italic, code, lists, quote, divider, tables, links,
//      line breaks).
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
  // [text](url) - http(s) or mailto only; otherwise leave the literal text.
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, function (m, txt, url) {
    return '<a href="' + url + '" target="_blank" rel="noopener nofollow">' + txt + '</a>';
  });
  return out;
}

// A GFM table separator row: only pipes, dashes, colons and spaces, with at
// least one dash. Used as the signal that the line above it is a header row.
function isTableSeparator(line) {
  var t = String(line).trim();
  if (t.indexOf('-') === -1) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t);
}
// Split a pipe row into trimmed cells, tolerating optional leading/trailing pipes.
function splitRow(line) {
  var s = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split('|').map(function (c) { return c.trim(); });
}
function alignOf(spec) {
  var s = String(spec).trim();
  var l = s.charAt(0) === ':', r = s.charAt(s.length - 1) === ':';
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return '';
}
function cell(tag, text, align) {
  var st = align ? ' style="text-align:' + align + '"' : '';
  return '<' + tag + st + '>' + inline(esc(text)) + '</' + tag + '>';
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

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var e = esc(line);
    var trimmed = e.trim();

    if (trimmed === '') { flushAll(); continue; }

    // Table: a row containing a pipe, immediately followed by a separator row.
    // Parsed from the RAW lines (pipes intact) so a header cell keeps its text.
    if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushAll();
      var header = splitRow(line);
      var aligns = splitRow(lines[i + 1]).map(alignOf);
      var n = header.length;
      var bodyRows = [];
      var j = i + 2;
      for (; j < lines.length; j++) {
        if (lines[j].indexOf('|') === -1 || lines[j].trim() === '') break;
        bodyRows.push(splitRow(lines[j]));
      }
      var html = '<div class="tbl-wrap"><table><thead><tr>';
      for (var c = 0; c < n; c++) html += cell('th', header[c] || '', aligns[c]);
      html += '</tr></thead><tbody>';
      for (var r = 0; r < bodyRows.length; r++) {
        html += '<tr>';
        for (var cc = 0; cc < n; cc++) html += cell('td', bodyRows[r][cc] || '', aligns[cc]);
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      out.push(html);
      i = j - 1;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushAll(); out.push('<hr>'); continue; }

    // Heading (# .. ###  ->  h2 .. h4, since h1 is the page/post title).
    var hm = /^(#{1,3})\s+(.*)$/.exec(e);
    if (hm) { flushAll(); var lvl = hm[1].length + 1; out.push('<h' + lvl + '>' + inline(hm[2].trim()) + '</h' + lvl + '>'); continue; }

    // Blockquote ('>' was escaped to '&gt;').
    var qm = /^&gt;\s?(.*)$/.exec(e);
    if (qm) { flushPara(); flushList(); quote.push(inline(qm[1])); continue; }

    // Unordered list item.
    var um = /^[-*]\s+(.*)$/.exec(trimmed);
    if (um) { flushPara(); flushQuote(); if (listType && listType !== 'ul') flushList(); listType = 'ul'; listItems.push(inline(um[1])); continue; }

    // Ordered list item.
    var om = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (om) { flushPara(); flushQuote(); if (listType && listType !== 'ol') flushList(); listType = 'ol'; listItems.push(inline(om[1])); continue; }

    // Plain paragraph line.
    flushList(); flushQuote();
    para.push(inline(e));
  }

  flushAll();
  return out.join('\n');
}

module.exports = { toRichHtml, esc };

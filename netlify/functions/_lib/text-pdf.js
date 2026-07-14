// netlify/functions/_lib/text-pdf.js
// Minimal, dependency-light text -> PDF using pdf-lib (already a project dep).
// Renders a title + body with word wrapping, pagination, and light Markdown
// awareness: # headings become bold/larger, **bold** and leading -/* bullets are
// handled, and GFM pipe tables are drawn as real grids. This is for downloadable
// template documents, not pixel-perfect typesetting.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// Standard Helvetica (WinAnsi) cannot encode emojis or arbitrary unicode and
// pdf-lib THROWS on such characters. Map the common typographic ones to ASCII
// and drop anything else outside the printable ASCII range.
function sanitize(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•●▪]/g, '*')
    .replace(/ /g, ' ')
    .replace(/[→➔➤]/g, '->')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function isTableSeparator(line) {
  var t = String(line).trim();
  if (t.indexOf('-') === -1) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t);
}
function splitRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim().replace(/\*\*/g, '').replace(/`/g, ''); });
}

async function buildTextPdf(title, bodyMarkdown) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 612, PAGE_H = 792, MARGIN = 54;
  const MAXW = PAGE_W - MARGIN * 2;
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  function newPage() { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; }

  // Wrap a string to lines that fit maxw at the given size/font.
  function wrapW(text, f, size, maxw) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
      let w = words[i];
      // Hard-break a single word longer than the column.
      while (f.widthOfTextAtSize(w, size) > maxw && w.length > 1) {
        let k = w.length;
        while (k > 1 && f.widthOfTextAtSize(w.slice(0, k), size) > maxw) k--;
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, k));
        w = w.slice(k);
      }
      const test = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > maxw && cur) { lines.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function draw(text, f, size, gap) {
    const lines = wrapW(sanitize(text), f, size, MAXW);
    for (let i = 0; i < lines.length; i++) {
      if (y < MARGIN + size) newPage();
      page.drawText(lines[i], { x: MARGIN, y: y, size: size, font: f, color: rgb(0.1, 0.12, 0.14) });
      y -= size * 1.4;
    }
    y -= (gap || 0);
  }

  // Draw a GFM table (first row = header) as a real bordered grid, with cell
  // wrapping, header shading, and page breaks that repeat the header.
  function drawTable(rows) {
    if (!rows.length) return;
    const size = 9, pad = 5, lh = size * 1.32, line = rgb(0.78, 0.80, 0.82);
    const nCols = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    // Natural width of each column, then scale to fit the page.
    const natural = new Array(nCols).fill(0);
    rows.forEach(function (r) {
      for (let c = 0; c < nCols; c++) {
        const w = font.widthOfTextAtSize(sanitize(r[c] || ''), size) + pad * 2;
        if (w > natural[c]) natural[c] = w;
      }
    });
    let total = natural.reduce(function (a, b) { return a + b; }, 0);
    const colW = natural.map(function (w) { return total > MAXW ? Math.max(34, w / total * MAXW) : w; });

    function rowHeight(cells) {
      let maxLines = 1;
      for (let c = 0; c < nCols; c++) {
        const ls = wrapW(sanitize(cells[c] || ''), font, size, colW[c] - pad * 2);
        if (ls.length > maxLines) maxLines = ls.length;
      }
      return maxLines * lh + pad * 2;
    }
    function drawRow(cells, isHeader) {
      const h = rowHeight(cells);
      if (y - h < MARGIN) { newPage(); }
      const top = y, f = isHeader ? bold : font;
      if (isHeader) {
        page.drawRectangle({ x: MARGIN, y: top - h, width: colW.reduce(function (a, b) { return a + b; }, 0), height: h, color: rgb(0.93, 0.96, 0.95) });
      }
      let x = MARGIN;
      for (let c = 0; c < nCols; c++) {
        const ls = wrapW(sanitize(cells[c] || ''), font, size, colW[c] - pad * 2);
        let ty = top - pad - size;
        for (let k = 0; k < ls.length; k++) {
          page.drawText(ls[k], { x: x + pad, y: ty, size: size, font: f, color: rgb(0.12, 0.14, 0.16) });
          ty -= lh;
        }
        // Vertical cell border.
        page.drawLine({ start: { x: x, y: top }, end: { x: x, y: top - h }, thickness: 0.5, color: line });
        x += colW[c];
      }
      // Right edge + bottom border.
      page.drawLine({ start: { x: x, y: top }, end: { x: x, y: top - h }, thickness: 0.5, color: line });
      page.drawLine({ start: { x: MARGIN, y: top - h }, end: { x: x, y: top - h }, thickness: 0.5, color: line });
      y = top - h;
    }
    // Top border.
    if (y < MARGIN + 20) newPage();
    const fullW = colW.reduce(function (a, b) { return a + b; }, 0);
    page.drawLine({ start: { x: MARGIN, y: y }, end: { x: MARGIN + fullW, y: y }, thickness: 0.5, color: line });
    drawRow(rows[0], true);
    for (let r = 1; r < rows.length; r++) drawRow(rows[r], false);
    y -= 8;
  }

  // Title.
  if (title) { draw(String(title).replace(/[#*_`]/g, '').trim(), bold, 17, 10); }

  const src = String(bodyMarkdown == null ? '' : bodyMarkdown).replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < src.length; i++) {
    let lineText = src[i];
    if (!lineText.trim()) { y -= 6; continue; }

    // Table: header row followed by a separator row.
    if (lineText.indexOf('|') !== -1 && i + 1 < src.length && isTableSeparator(src[i + 1])) {
      const rows = [splitRow(lineText)];
      let j = i + 2;
      for (; j < src.length; j++) {
        if (src[j].indexOf('|') === -1 || !src[j].trim()) break;
        rows.push(splitRow(src[j]));
      }
      drawTable(rows);
      i = j - 1;
      continue;
    }

    // Headings.
    const hm = /^(#{1,4})\s+(.*)$/.exec(lineText);
    if (hm) { draw(hm[2].replace(/\*\*/g, ''), bold, 12.5, 4); continue; }
    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(lineText.trim())) {
      if (y < MARGIN + 12) newPage();
      page.drawLine({ start: { x: MARGIN, y: y }, end: { x: PAGE_W - MARGIN, y: y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
      y -= 12; continue;
    }
    // List item.
    const lm = /^\s*[-*]\s+(.*)$/.exec(lineText);
    if (lm) { draw('• ' + lm[1].replace(/\*\*/g, ''), font, 10.5, 2); continue; }
    const om = /^\s*(\d+)\.\s+(.*)$/.exec(lineText);
    if (om) { draw(om[1] + '. ' + om[2].replace(/\*\*/g, ''), font, 10.5, 2); continue; }
    // Plain paragraph (strip markdown emphasis markers for the flat render).
    draw(lineText.replace(/\*\*/g, '').replace(/`/g, ''), font, 10.5, 3);
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

module.exports = { buildTextPdf };

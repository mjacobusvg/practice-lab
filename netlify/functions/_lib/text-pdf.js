// netlify/functions/_lib/text-pdf.js
// Minimal, dependency-light text -> PDF using pdf-lib (already a project dep).
// Renders a title + body with word wrapping, pagination, and light Markdown
// awareness (# headings become bold/larger; **bold** and leading -/* bullets are
// handled simply). This is for downloadable template documents, not pixel-perfect
// typesetting.

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
    .replace(/ /g, ' ')
    .replace(/[→➔➤]/g, '->')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
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

  // Wrap a string to lines that fit MAXW at the given size/font.
  function wrap(text, f, size) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
      const test = cur ? cur + ' ' + words[i] : words[i];
      if (f.widthOfTextAtSize(test, size) > MAXW && cur) { lines.push(cur); cur = words[i]; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function draw(text, f, size, gap) {
    const lines = wrap(sanitize(text), f, size);
    for (let i = 0; i < lines.length; i++) {
      if (y < MARGIN + size) newPage();
      page.drawText(lines[i], { x: MARGIN, y: y, size: size, font: f, color: rgb(0.1, 0.12, 0.14) });
      y -= size * 1.4;
    }
    y -= (gap || 0);
  }

  // Title.
  if (title) { draw(String(title).replace(/[#*_`]/g, '').trim(), bold, 17, 10); }

  const src = String(bodyMarkdown == null ? '' : bodyMarkdown).replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < src.length; i++) {
    let line = src[i];
    if (!line.trim()) { y -= 6; continue; }
    // Headings.
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm) { draw(hm[2].replace(/\*\*/g, ''), bold, 12.5, 4); continue; }
    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      if (y < MARGIN + 12) newPage();
      page.drawLine({ start: { x: MARGIN, y: y }, end: { x: PAGE_W - MARGIN, y: y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
      y -= 12; continue;
    }
    // List item.
    const lm = /^\s*[-*]\s+(.*)$/.exec(line);
    if (lm) { draw('• ' + lm[1].replace(/\*\*/g, ''), font, 10.5, 2); continue; }
    const om = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (om) { draw(om[1] + '. ' + om[2].replace(/\*\*/g, ''), font, 10.5, 2); continue; }
    // Plain paragraph (strip markdown emphasis markers for the flat render).
    draw(line.replace(/\*\*/g, '').replace(/`/g, ''), font, 10.5, 3);
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

module.exports = { buildTextPdf };

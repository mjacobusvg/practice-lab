// netlify/functions/_lib/build-letter-pdf.js
// Server-side letter/form PDF builder. Ports the client-side pdf-lib pipeline from
// pm-letter-generator.html so a cron job (no browser) can produce the SAME finished PDF:
// letterhead overlay, Times font, template render with vault data, signature compositing,
// pagination. Used by letter-autosend-cron.js. pdf-lib runs in Node unchanged.
//
// Pure data in, PDF bytes out. No DOM. base64 handled with Buffer (not atob).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

var LIB_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var LIB_MONTH_ABBR = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11,
  january:0,february:1,march:2,april:3,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
var LIB_TITLE_MINOR = { a:1,an:1,and:1,as:1,at:1,but:1,by:1,for:1,'in':1,nor:1,of:1,on:1,or:1,per:1,the:1,to:1,vs:1,via:1,'with':1 };
var LIB_UPPER = { llc:1,pllc:1,pc:1,pa:1,dba:1,ada:1,fmla:1,esa:1,hoa:1,hr:1,ein:1,npi:1,dea:1,usa:1,us:1,id:1,ii:1,iii:1,iv:1 };

function _libTitleCaseWord(w, isFirst, isLast) {
  if (!w) return w;
  var lower = w.toLowerCase();
  if (LIB_UPPER[lower]) return lower.toUpperCase();
  if (w.indexOf('-') !== -1) {
    return w.split('-').map(function(part){ return _libTitleCaseWord(part, true, true); }).join('-');
  }
  if (/^mc[a-z]/.test(lower)) return 'Mc' + lower.charAt(2).toUpperCase() + lower.slice(3);
  if (/^o'[a-z]/.test(lower)) return "O'" + lower.charAt(2).toUpperCase() + lower.slice(3);
  if (!isFirst && !isLast && LIB_TITLE_MINOR[lower]) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function libTitleCase(str) {
  if (!str) return str;
  var s = String(str).trim().replace(/\s+/g, ' ');
  if (!s) return s;
  var words = s.split(' ');
  var allCaps = s === s.toUpperCase();
  var allLower = s === s.toLowerCase();
  if (!allCaps && !allLower) {
    var hasIntentional = words.some(function(w){ return /[a-z][A-Z]/.test(w) || (/[A-Z]/.test(w.slice(1)) && !/^[A-Z]+$/.test(w)); });
    if (hasIntentional) return s;
  }
  return words.map(function(w, i){ return _libTitleCaseWord(w, i === 0, i === words.length - 1); }).join(' ');
}

function libNormalizeDate(input) {
  if (input === undefined || input === null) return null;
  var s = String(input).trim();
  if (!s) return null;
  var written = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (written && LIB_MONTH_ABBR[written[1].toLowerCase()] !== undefined) {
    var wm = LIB_MONTH_ABBR[written[1].toLowerCase()];
    return LIB_MONTHS[wm] + ' ' + parseInt(written[2],10) + ', ' + written[3];
  }
  var monthYear = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (monthYear && LIB_MONTH_ABBR[monthYear[1].toLowerCase()] !== undefined) {
    return LIB_MONTHS[LIB_MONTH_ABBR[monthYear[1].toLowerCase()]] + ' ' + monthYear[2];
  }
  var mo, day, yr;
  var iso = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (iso) { yr = +iso[1]; mo = +iso[2]; day = +iso[3]; }
  if (mo === undefined) {
    var us = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})$/);
    if (us) { mo = +us[1]; day = +us[2]; yr = +us[3]; if (yr < 100) yr += (yr < 50 ? 2000 : 1900); }
  }
  if (mo === undefined) {
    var eight = s.match(/^(\d{2})(\d{2})(\d{4})$/);
    if (eight) { mo = +eight[1]; day = +eight[2]; yr = +eight[3]; }
  }
  if (mo === undefined) {
    var six = s.match(/^(\d{2})(\d{2})(\d{2})$/);
    if (six) { mo = +six[1]; day = +six[2]; yr = +six[3] + (+six[3] < 50 ? 2000 : 1900); }
  }
  if (mo === undefined || day === undefined || yr === undefined) return null;
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || yr < 1900 || yr > 2200) return null;
  return LIB_MONTHS[mo - 1] + ' ' + day + ', ' + yr;
}

function libSentenceCase(str) {
  if (!str) return str;
  var s = String(str).trim().replace(/\s+/g, ' ');
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function libNormalizeValue(key, value, fmt) {
  if (value === undefined || value === null) return value;
  var raw = String(value);
  if (!raw.trim()) return value;
  if (!fmt) {
    if (/(_DATE|^DATE|_START$|_ON$)/.test(key) || key === 'TREATMENT_START' || key === 'JURY_DATE') fmt = 'date';
    else if (/(NAME)$/.test(key) || key === 'PATIENT_NAME' || key === 'PATIENT_FIRST_NAME') fmt = 'name';
    else fmt = 'none';
  }
  if (fmt === 'date') {
    var d = libNormalizeDate(raw);
    return d !== null ? d : value;
  }
  if (fmt === 'name' || fmt === 'titlecase') return libTitleCase(raw);
  if (fmt === 'sentence') return libSentenceCase(raw);
  if (fmt === 'upper') return raw.trim().toUpperCase();
  if (fmt === 'lower') return raw.trim().toLowerCase();
  return value;
}

function libRenderTemplate(template, placeholders, toggles, placeholderDefs) {
  if (!template) return '';
  var output = template;
  var ifPattern = /\{\{#IF ([a-zA-Z_]+)=([a-zA-Z_]+)\}\}([\s\S]*?)\{\{\/IF\}\}/g;
  output = output.replace(ifPattern, function(match, toggleKey, value, content) {
    return toggles[toggleKey] === value ? content : '';
  });
  var requiredMap = {};
  var formatMap = {};
  if (placeholderDefs && Array.isArray(placeholderDefs)) {
    placeholderDefs.forEach(function(p) { requiredMap[p.key] = !!p.required; formatMap[p.key] = p.format; });
  }
  output = output.replace(/\{\{([A-Z_]+)\}\}/g, function(match, key) {
    var val = placeholders[key];
    if (val !== undefined && val !== null && val !== '') {
      return libNormalizeValue(key, val, formatMap[key]);
    }
    if (requiredMap[key]) return '[' + key + ' - needs input]';
    return '';
  });
  output = output.replace(/,[ \t]+\n/g, '\n');
  output = output.replace(/^[ \t]+\n/gm, '\n');
  output = output.replace(/\n{3,}/g, '\n\n');
  return output;
}

// Node base64 -> Uint8Array (replaces browser atob).
function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function libInjectSignatureAnchor(text, vault) {
  if (!text) return text;
  if (text.indexOf('[SIGNATURE]') !== -1) return text;
  var name = (vault && (vault.legalName || vault.providerName || vault.name) || '').trim();
  var lines = text.split('\n');
  function normalize(s) { return s.replace(/\s+/g, ' ').trim().toLowerCase(); }
  var targetIdx = -1;
  if (name) {
    var nName = normalize(name);
    for (var i = lines.length - 1; i >= 0; i--) {
      var ln = normalize(lines[i]);
      if (!ln) continue;
      if (ln === nName || ln.indexOf(nName) === 0) { targetIdx = i; break; }
    }
  }
  if (targetIdx === -1) {
    var closingRe = /^(sincerely|respectfully|regards|best regards|warm regards|thank you)[,.]?$/i;
    for (var j = lines.length - 1; j >= 0; j--) {
      if (closingRe.test(lines[j].trim())) { targetIdx = j + 1; break; }
    }
  }
  if (targetIdx === -1) {
    lines.push(''); lines.push('[SIGNATURE]');
    return lines.join('\n');
  }
  var insertAt = targetIdx;
  var prevBlank = insertAt > 0 && lines[insertAt - 1].trim() === '';
  var block = prevBlank ? ['[SIGNATURE]'] : ['', '[SIGNATURE]'];
  lines.splice.apply(lines, [insertAt, 0].concat(block));
  return lines.join('\n');
}

function libStripVaultHeaderFromText(text) {
  var lines = text.split('\n');
  var dateRegex = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\s*$/i;
  for (var i = 0; i < Math.min(lines.length, 20); i++) {
    if (dateRegex.test(lines[i].trim())) {
      return lines.slice(i).join('\n');
    }
  }
  return text;
}

function libWrapTextLines(text, font, fontSize, maxWidth) {
  var paragraphs = text.split('\n');
  var lines = [];
  for (var p = 0; p < paragraphs.length; p++) {
    var para = paragraphs[p];
    if (para.length === 0) { lines.push(''); continue; }
    var words = para.split(' ');
    var currentLine = '';
    for (var w = 0; w < words.length; w++) {
      var word = words[w];
      var testLine = currentLine ? currentLine + ' ' + word : word;
      var testWidth = 0;
      try { testWidth = font.widthOfTextAtSize(testLine, fontSize); }
      catch (e) { testWidth = testLine.length * fontSize * 0.5; }
      if (testWidth > maxWidth && currentLine) { lines.push(currentLine); currentLine = word; }
      else { currentLine = testLine; }
    }
    if (currentLine) lines.push(currentLine);
  }
  return lines;
}

// Sanitizes text for WinAnsi (StandardFonts.TimesRoman) so smart quotes/dashes from
// stored templates don't throw during drawText. Mirrors what the browser tolerates.
function sanitizeWinAnsi(s) {
  if (!s) return s;
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ');
}

/**
 * Build the finished PDF for a letter/form, server-side.
 * @param {Object} args
 *   bodyTemplate   {string}  the standard's body_template (with {{...}} and {{#IF}})
 *   placeholders   {Object}  resolved placeholder values (PROVIDER_NAME, dates, etc.)
 *   toggles        {Object}  resolved toggle values (svc_followup, etc.)
 *   placeholderDefs{Array}   the standard's placeholders[] (for required/format)
 *   vault          {Object}  the provider's vault_profile data (letterhead, signature, name)
 *   sign           {boolean} composite the signature
 * @returns {Promise<Uint8Array>} PDF bytes
 */
async function buildLetterPdf(args) {
  var bodyTemplate = args.bodyTemplate || '';
  var placeholders = args.placeholders || {};
  var toggles = args.toggles || {};
  var placeholderDefs = args.placeholderDefs || [];
  var vault = args.vault || {};
  var sign = !!args.sign;
  var forceNoLetterhead = !!args.noLetterhead;

  var letterText = libRenderTemplate(bodyTemplate, placeholders, toggles, placeholderDefs);

  var letterheadData = vault.letterhead || '';
  var hasLetterhead = !forceNoLetterhead
    && typeof letterheadData === 'string'
    && letterheadData.indexOf('data:application/pdf') === 0;

  var pdfDoc, firstPage, pageWidth, pageHeight;
  if (hasLetterhead) {
    var bytes = b64ToBytes(letterheadData.split(',')[1] || '');
    pdfDoc = await PDFDocument.load(bytes);
    firstPage = pdfDoc.getPage(0);
    pageWidth = firstPage.getWidth();
    pageHeight = firstPage.getHeight();
  } else {
    pdfDoc = await PDFDocument.create();
    pageWidth = 612; pageHeight = 792;
    firstPage = pdfDoc.addPage([pageWidth, pageHeight]);
  }

  var font = await pdfDoc.embedFont(StandardFonts.TimesRoman);

  var letterheadConfig = vault.letterheadConfig || {};
  var marginTop = (letterheadConfig.marginTopInches || 2.0) * 72;
  var marginBottom = (letterheadConfig.marginBottomInches || 1.5) * 72;
  var marginLeft = (letterheadConfig.marginLeftInches || 1.0) * 72;
  var marginRight = (letterheadConfig.marginRightInches || 1.0) * 72;
  if (!hasLetterhead) marginTop = 0.75 * 72;

  var fontSize = 11;
  var lineHeight = fontSize * 1.4;
  var textWidth = pageWidth - marginLeft - marginRight;

  var bodyText = hasLetterhead ? libStripVaultHeaderFromText(letterText) : letterText;

  var sigData = vault.signature || '';
  var hasSignature = sign && typeof sigData === 'string' && sigData.indexOf('data:image/png') === 0;
  var sigImage = null, sigDrawWidth = 0, sigDrawHeight = 0;
  if (hasSignature) {
    try {
      var sigBytes = b64ToBytes(sigData.split(',')[1] || '');
      sigImage = await pdfDoc.embedPng(sigBytes);
      sigDrawWidth = 1.8 * 72;
      sigDrawHeight = sigImage.height * (sigDrawWidth / sigImage.width);
    } catch (sigErr) {
      hasSignature = false;
    }
  }

  var SIG_GAP = 6;
  if (hasSignature) bodyText = libInjectSignatureAnchor(bodyText, vault);

  var lines = libWrapTextLines(bodyText, font, fontSize, textWidth);

  var y = pageHeight - marginTop;
  var minY = marginBottom;
  var currentPage = firstPage;

  for (var i = 0; i < lines.length; i++) {
    var rawLine = lines[i];
    if (rawLine.trim() === '[SIGNATURE]') {
      if (hasSignature && sigImage) {
        var needed = sigDrawHeight + SIG_GAP * 2;
        if (y - needed < minY) {
          currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
          y = pageHeight - (0.75 * 72);
        }
        var sigTop = y - SIG_GAP;
        currentPage.drawImage(sigImage, {
          x: marginLeft, y: sigTop - sigDrawHeight,
          width: sigDrawWidth, height: sigDrawHeight
        });
        y -= (sigDrawHeight + SIG_GAP * 2);
      } else {
        y -= lineHeight;
      }
      continue;
    }
    if (y - lineHeight < minY) {
      currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - (0.75 * 72);
    }
    currentPage.drawText(sanitizeWinAnsi(rawLine), {
      x: marginLeft, y: y - fontSize, size: fontSize, font: font,
      color: rgb(0, 0, 0)
    });
    y -= lineHeight;
  }

  return await pdfDoc.save();
}

module.exports = {
  buildLetterPdf,
  // exported for unit testing
  _internals: { libRenderTemplate, libNormalizeValue, libTitleCase, libNormalizeDate }
};

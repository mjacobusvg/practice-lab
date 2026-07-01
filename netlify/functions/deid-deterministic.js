/**
 * _lib/deid-deterministic.js
 *
 * Deterministic second-pass PHI scrub. Runs AFTER the AI de-identification pass.
 * Purpose: guarantee that shaped identifiers (SSN, phone, email, MRN/account IDs,
 * ZIP, dates, addresses, ages 90+, IPs, URLs) are removed even if the model missed one.
 *
 * The AI handles the shapeless identifiers (names, employers, schools, places) that
 * patterns cannot catch. This module handles the shaped identifiers that patterns catch
 * perfectly and that a model can occasionally overlook. Together: full coverage.
 *
 * This module NEVER logs input text. It returns the scrubbed string plus category counts.
 */

'use strict';

function scrubDeterministic(text) {
  const log = [];
  let out = String(text == null ? '' : text);

  function rep(re, tag, label) {
    out = out.replace(re, () => { log.push(label); return tag; });
  }

  // Order matters: email before phone (so an email isn't half-consumed),
  // labeled IDs before bare long-number IDs, dates before ZIP-like 5-digit runs.

  // SSN
  rep(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]', 'ssn');

  // Email
  rep(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]', 'email');

  // URLs
  rep(/\bhttps?:\/\/[^\s)]+/gi, '[URL]', 'url');

  // Dates (numeric m/d/y, and long forms)
  rep(/\b(0?[1-9]|1[0-2])[\/\-.](0?[1-9]|[12]\d|3[01])[\/\-.](\d{4}|\d{2})\b/g, '[DATE]', 'date');
  rep(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi, '[DATE]', 'date');
  rep(/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/gi, '[DATE]', 'date');

  // Phone / fax
  rep(/\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[PHONE]', 'phone');

  // Labeled IDs (MRN, account, member, policy, chart, claim)
  rep(/\b(?:MRN|Medical Record(?: Number)?|Acct(?:ount)?|Member(?:\s*ID)?|Policy|Subscriber|Chart|Claim)\s*#?:?\s*[A-Z0-9-]{4,}\b/gi, '[ID]', 'id');

  // Alphanumeric IDs (letters+digits, e.g. GSC131723497001) and long numeric runs
  rep(/\b[A-Z]{2,}\d{6,}\b/g, '[ID]', 'id');
  rep(/\b\d{7,}\b/g, '[ID]', 'id');

  // Street address
  rep(/\b\d{1,6}\s+([A-Z0-9][A-Za-z0-9.]*\s+){0,3}(Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Highway|Hwy)\b\.?(?:\s+(?:Ste|Suite|Apt|Unit)\s*#?\s*\w+)?/gi, '[ADDRESS]', 'address');

  // ZIP (after dates/ids/phones so it doesn't eat pieces of those)
  rep(/\b\d{5}(?:-\d{4})?\b/g, '[ZIP]', 'zip');

  // Ages 90+ (Safe Harbor requires aggregation over 89)
  rep(/\b(9\d|1\d{2})\s*(?:years?\s*old|y\/?o|yo)\b/gi, '[AGE 90+]', 'age90plus');

  // IP addresses
  rep(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]', 'ip');

  const counts = {};
  for (const l of log) counts[l] = (counts[l] || 0) + 1;

  return { text: out, counts, total: log.length };
}

module.exports = { scrubDeterministic };

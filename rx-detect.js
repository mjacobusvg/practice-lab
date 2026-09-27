// Medication candidate detection.
//
// THE RULE THIS FILE EXISTS TO ENFORCE, in two parts:
//
// 1. A dictionary hit means "a medication is MENTIONED". It never means "the patient is
//    currently taking this". "Stopped fluoxetine six months ago" and "previously failed
//    Concerta" are mentions. Putting either into the current medication list because the word
//    appeared is how a scribe invents a regimen. Everything here is a CANDIDATE with a
//    PROPOSED status; only the clinician's confirmation makes it real.
//
// 2. Detection must not destroy specificity it can see. The vocabulary is ingredient-level
//    (Ritalin and Concerta share one interaction key, as they should for CYP purposes), but
//    "Adderall XR" written in a note is a more specific fact than "amphetamine", and it is the
//    fact that decides which label, which formulation and which maximum dose apply. Collapsing
//    "Adderall XR" to "Adderall" is the exact error that produced a hallucinated 30 mg maximum.
//    So the matched text is preserved verbatim, release-form modifiers included, and the
//    ingredient-level key rides ALONGSIDE it rather than replacing it.
//
// Pure and dependency-free so it can be unit tested outside a browser.

(function (root) {
  'use strict';

  // Release-form modifiers, as written on real products. Captured because the difference between
  // Adderall and Adderall XR is a different label with a different maximum.
  var FORMS = {
    xr: 'extended-release', er: 'extended-release', sr: 'sustained-release',
    xl: 'extended-release', cd: 'controlled-delivery', la: 'long-acting',
    cr: 'controlled-release', dr: 'delayed-release', ir: 'immediate-release',
    odt: 'orally disintegrating', sl: 'sublingual', ec: 'enteric-coated'
  };
  var FORM_RE = new RegExp('^[\\s-]*(' + Object.keys(FORMS).join('|') + ')\\b', 'i');

  var DOSE_RE = /^[\s:-]*(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|units?|iu)\b(?:\s*\/\s*(\d+(?:\.\d+)?)\s*(mg|mcg|ml))?/i;
  // Combination strengths are also written with ONE unit at the end: "Symbyax 6/25 mg",
  // "Suboxone 8/2 mg". Without this the dose is dropped entirely, which the coverage audit
  // showed as a blank next to a drug the clinician had clearly dosed.
  var COMBO_DOSE_RE = /^[\s:-]*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(mg|mcg)\b/i;

  var ROUTES = [
    [/\b(?:po|by mouth|orally|oral)\b/i, 'oral'],
    [/\bsublingual(?:ly)?\b|\bsl\b/i, 'sublingual'],
    [/\bintranasal(?:ly)?\b|\bnasal spray\b/i, 'intranasal'],
    [/\btransdermal\b|\bpatch\b/i, 'transdermal'],
    [/\b(?:im|intramuscular(?:ly)?)\b/i, 'intramuscular'],
    [/\b(?:iv|intravenous(?:ly)?)\b/i, 'intravenous'],
    [/\bsubcutaneous(?:ly)?\b|\bsubq\b|\bsq\b/i, 'subcutaneous'],
    [/\btopical(?:ly)?\b/i, 'topical'],
    [/\binhaled?\b|\binhaler\b/i, 'inhaled']
  ];

  var FREQ_RE = /\b(?:bid|tid|qid|qhs|qam|qpm|qd|daily|nightly|prn|as needed|once (?:a|per) day|twice (?:a|per) day|three times (?:a|per) day|every (?:morning|night|evening)|q\s*\d+\s*h(?:ours?)?|weekly|monthly)\b/i;

  // Status cues. Deliberately biased: anything suggesting the past wins over anything suggesting
  // the present, because wrongly listing a stopped drug as current is the dangerous direction.
  var PAST = [
    /\bstopp?ed\b/i, /\bdiscontinued?\b/i, /\bd\/c(?:'d|ed)?\b/i, /\bcame off\b/i,
    /\bwas (?:on|taking|started)\b/i, /\bhad been (?:on|taking)\b/i, /\bused to\b/i,
    /\bpreviously\b/i, /\bprior(?:\s+to)?\b/i, /\bformerly\b/i, /\bin the past\b/i,
    /\bhistory of\b/i, /\bfailed\b/i, /\bdid not (?:tolerate|work|help)\b/i,
    /\bdidn'?t (?:tolerate|work|help)\b/i, /\bintolerant\b/i, /\btrial(?:ed|led)? (?:of|on)?\b/i,
    /\btried\b/i, /\bno longer\b/i, /\bweaned\b/i, /\btapered off\b/i, /\boff of\b/i,
    /\bceased\b/i, /\bheld\b/i, /\bnever (?:started|took)\b/i
  ];
  // Each alternative ends on a word character, never on a literal trailing space: a pattern like
  // /\bcontinues? (?:on|taking)?\b/ fails on "Continue Adderall" once the cue zone puts another
  // space after it, because space-space is not a word boundary. That silently downgraded every
  // "Continue <drug>" plan line to 'unclear'.
  var PRESENT = [
    /\bcurrently\b/i, /\bcurrent\b/i, /\bactive\b/i,   // a med-list line often just says "- current"
    /\bcontinu(?:e|es|ed|ing)\b/i, /\bremains?\b/i,
    /\bre-?start(?:ed|ing|s)?\b/i, /\bresum(?:e|es|ed|ing)\b/i,
    /\btaking\b/i, /\btakes?\b/i, /\bon\b/i, /\bprescribed?\b/i, /\brx(?:'d|ed)?\b/i,
    /\bstart(?:ed|ing|s)?\b/i, /\bstable\b/i, /\bmaintained\b/i, /\btolerat(?:es|ing)\b/i,
    /\brefill(?:ed|s)?\b/i, /\bincreas(?:e|ed|ing)\b/i, /\bdecreas(?:e|ed|ing)\b/i,
    /\btitrat(?:e|ed|ing)\b/i, /\bsame dose\b/i, /\bno change\b/i
  ];
  // "started X two weeks ago" is CURRENT. "stopped X two weeks ago" is not. So a bare past-tense
  // time marker is not itself evidence of stopping, and is not in the PAST list.

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function buildIndex(vocab) {
    var terms = [];
    (vocab.entries || []).forEach(function (e) {
      (e.generics || []).forEach(function (t) { terms.push({ term: t, entry: e, kind: 'generic' }); });
      (e.brands || []).forEach(function (t) { terms.push({ term: t, entry: e, kind: 'brand' }); });
    });
    // Longest first: "mixed amphetamine salts" must win over "amphetamine".
    terms.sort(function (a, b) { return b.term.length - a.term.length; });
    var byLower = {};
    terms.forEach(function (t) { if (!byLower[t.term.toLowerCase()]) byLower[t.term.toLowerCase()] = t; });
    var re = new RegExp('(?<![A-Za-z])(' + terms.map(function (t) { return escapeRe(t.term); }).join('|') +
                        ')(?![A-Za-z])', 'gi');
    return { re: re, byLower: byLower };
  }

  // The sentence containing an offset, so a status cue from a different sentence cannot leak in.
  function sentenceAround(text, at) {
    var start = 0, end = text.length;
    for (var i = at; i > 0; i--) {
      var c = text[i - 1];
      if (c === '\n' || ((c === '.' || c === ';' || c === '!' || c === '?') && /\s/.test(text[i] || ' '))) { start = i; break; }
    }
    for (var j = at; j < text.length; j++) {
      var d = text[j];
      if (d === '\n' || ((d === '.' || d === ';' || d === '!' || d === '?') && /\s|$/.test(text[j + 1] || ' '))) { end = j + 1; break; }
    }
    return { text: text.slice(start, end).trim(), start: start, end: end };
  }

  function firstMatch(list, s) {
    for (var i = 0; i < list.length; i++) if (list[i].test(s)) return true;
    return false;
  }

  function detect(text, opts) {
    opts = opts || {};
    var vocab = opts.vocab || root.TBP_RX_VOCAB;
    if (!vocab || !vocab.entries) return [];
    if (typeof text !== 'string' || !text.trim()) return [];
    var includeSubstances = !!opts.includeSubstances;
    var idx = buildIndex(vocab);
    var out = [];
    var m;
    idx.re.lastIndex = 0;
    while ((m = idx.re.exec(text))) {
      var hit = idx.byLower[m[1].toLowerCase()];
      if (!hit) continue;
      if (hit.entry.substance && !includeSubstances) continue;

      var at = m.index, matched = m[1];
      var after = text.slice(at + matched.length, at + matched.length + 60);

      // Release form, if written right after the name. "Adderall XR", "Wellbutrin-SR".
      var formHint = null, formWord = '', consumed = 0;
      var fm = after.match(FORM_RE);
      if (fm) { formWord = fm[1]; formHint = FORMS[fm[1].toLowerCase()]; consumed = fm[0].length; }

      var rest = after.slice(consumed);
      var dose = null;
      var dm = rest.match(DOSE_RE);
      if (dm) dose = dm[3] ? (dm[1] + ' ' + dm[2] + '/' + dm[3] + ' ' + dm[4]) : (dm[1] + ' ' + dm[2].toLowerCase());
      if (!dm) {
        var cm = rest.match(COMBO_DOSE_RE);
        if (cm) { dm = cm; dose = cm[1] + '/' + cm[2] + ' ' + cm[3].toLowerCase(); }
      }

      var sent = sentenceAround(text, at);
      var route = null;
      for (var r = 0; r < ROUTES.length; r++) if (ROUTES[r][0].test(sent.text)) { route = ROUTES[r][1]; break; }
      var fq = sent.text.match(FREQ_RE);

      // Everything BEFORE this mention in its sentence, plus what follows it WITHIN THE SAME
      // SENTENCE, is where the cue lives: "stopped fluoxetine", "fluoxetine was discontinued".
      // Clipped at sent.end, without which "PCP started fluoxetine 40 mg two weeks ago."
      // followed by "Previously stopped Concerta" reads the next sentence's cue and files an
      // active prescription as historical.
      var pre = text.slice(sent.start, at);
      var tailFrom = at + matched.length + consumed + (dm ? dm[0].length : 0);
      var post = text.slice(tailFrom, Math.min(sent.end, tailFrom + 40));
      var cueZone = pre + ' ' + post;
      var status = 'unclear', why = '';
      if (firstMatch(PAST, cueZone)) { status = 'historical'; why = 'past-tense or discontinuation language nearby'; }
      else if (firstMatch(PRESENT, cueZone)) { status = 'current'; why = 'current-use language nearby'; }
      else { why = 'no clear indication whether this is current or historical'; }

      // A long-acting injectable is its own product with its own label, not a release form of
      // the oral drug. Marked explicitly so nothing downstream has to infer it from the name:
      // "Abilify Maintena 400 mg IM monthly" answered from the ORAL aripiprazole label is not
      // just the wrong number, it is the wrong units.
      var isLai = !!(hit.entry.lai && hit.entry.lai.indexOf(matched) > -1);
      var combo = (hit.entry.combinations || []).find(function(c){ return c.name === matched; });

      out.push({
        // Exactly as written, form modifier included. The most specific identity available, and
        // the one the clinician recognises.
        rawName: (matched + (formWord ? ' ' + formWord.toUpperCase() : '')).trim(),
        // One prescribing identity, components alongside (CLINICAL-ONTOLOGY.md 3.1).
        components: combo ? combo.components.slice() : null,
        lai: isLai,
        matchedTerm: matched,
        matchedAs: hit.kind,                 // 'brand' or 'generic'
        brand: hit.kind === 'brand' ? (matched + (formWord ? ' ' + formWord.toUpperCase() : '')) : null,
        interactionKey: hit.entry.key,       // for the existing deterministic checker ONLY
        ingredient: hit.entry.key.replace(/_/g, ' '),
        drugClass: hit.entry.cls || '',
        substance: !!hit.entry.substance,
        // The LAI product name IS the formulation statement, so it counts as written rather than
        // inferred: the clinician named a product that only exists as an injection.
        formulation: isLai ? 'long-acting injectable' : formHint,
        formulationSource: isLai ? 'product' : (formHint ? 'text' : null),
        dose: dose,
        route: route,
        frequency: fq ? fq[0].toLowerCase() : null,
        proposedStatus: status,
        statusReason: why,
        quote: sent.text.length > 220 ? sent.text.slice(0, 217) + '…' : sent.text,
        index: at
      });
    }
    return merge(out);
  }

  // Merge only where merging cannot lose a distinction. Two mentions are the same medication when
  // they share an ingredient and a proposed status AND nothing about them contradicts:
  //
  //   both carry a dose -> the doses must match. "lithium 600 mg" then "lithium 900 mg" is a
  //   change, not a repeat, and Adderall IR 20 mg is not Adderall XR 20 mg.
  //   only one carries a dose -> a bare later reference to a drug already listed. A note that
  //   says "Adderall XR 20 mg qam" and later "can we go higher on the Adderall" is discussing
  //   ONE prescription, and showing the clinician two rows for it is noise they have to clean up.
  //   stated release forms must agree wherever both are stated, since that is what picks the label.
  //
  // The surviving row is the most specific one, because that is what selects the right SPL, and
  // it keeps every quote so nothing that was merged becomes invisible.
  function compatibleForm(a, b) {
    return !a.formulation || !b.formulation || a.formulation === b.formulation;
  }
  function sameMedication(a, b) {
    if (a.interactionKey !== b.interactionKey) return false;
    if (a.proposedStatus !== b.proposedStatus) return false;
    // An injectable and an oral of the same ingredient are different products, always, whatever
    // the doses look like. Someone on Invega Sustenna monthly and oral Invega is on two things.
    if (!!a.lai !== !!b.lai) return false;
    if (!compatibleForm(a, b)) return false;
    if (a.dose && b.dose) return a.dose === b.dose;
    return true;
  }
  function merge(list) {
    var seen = [];
    list.forEach(function (c) {
      var prior = null;
      for (var i = 0; i < seen.length; i++) if (sameMedication(seen[i], c)) { prior = seen[i]; break; }
      if (!prior) { c.quotes = [c.quote]; seen.push(c); return; }
      if (prior.quotes.indexOf(c.quote) === -1) prior.quotes.push(c.quote);
      if (specificity(c) > specificity(prior)) {
        var keepQuotes = prior.quotes;
        seen[seen.indexOf(prior)] = c;
        c.quotes = keepQuotes;
      }
    });
    return seen;
  }
  function specificity(c) {
    return (c.formulation ? 4 : 0) + (c.matchedAs === 'brand' ? 2 : 0) + (c.dose ? 1 : 0);
  }

  var API = { detect: detect, sentenceAround: sentenceAround, FORMS: FORMS, _buildIndex: buildIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.TBP_RX_DETECT = API;
})(typeof window !== 'undefined' ? window : globalThis);

// Medication grounding: deciding when a question needs label evidence, formatting that evidence
// so a model cannot mistake it for the patient's chart, and telling the model what it may and
// may not do with it.
//
// This exists because of one concrete failure. Asked for the maximum Adderall dose, Discern
// answered 30 mg from model memory. 30 mg/day is the pediatric maximum in the Adderall XR label;
// the adult recommended dose is 20 mg/day and adult trials studied up to 60 mg/day. Three
// different facts, and the model collapsed them into one confident wrong number.
//
// Prompt engineering cannot fix that. A model asked to be careful about doses is still
// recalling. The fix is to put the actual label section in front of it and forbid recall for
// that class of fact.
//
// Pure and dependency-free so it can be unit tested outside a browser.

(function (root) {
  'use strict';

  // ── 1. Does this question need label evidence, and of which kind? ────────────────────────
  //
  // Bias: a false positive costs one retrieval. A false negative costs a fabricated dose in a
  // clinical answer. So anything that smells like a medication fact gets grounded.
  // NOTE ON THE PATTERNS: a prefix must end in \w* and NOT in \b. /\binteract(ion|s|ing)?\b/
  // looks right and silently fails on "interactions"; /\bpregnan\b/ fails on "pregnancy". Both
  // were in the first draft of this file, and a classifier that quietly misses "are there any
  // interactions" is a classifier that lets the ungrounded answer through.
  var CLASS_PATTERNS = [
    ['dosing', [
      /\b(max(imum)?|highest|ceiling|top|upper limit)\b[\s\S]{0,40}\b(dose|dosage|dosing|mg)\b/i,
      /\b(dose|dosage|dosing)\b[\s\S]{0,40}\b(max\w*|limit\w*|range|increas\w*|titrat\w*|go (up|higher)|rais\w*)/i,
      /\b(how (much|high)|go(ing)? higher|push (it |the dose )?(up|higher)|increas\w*|titrat\w*|taper\w*|reduc\w*|lower)\b[\s\S]{0,40}\b(dose|dosing|mg|on (the|her|his|their)\b)/i,
      /\bhow much\b[\s\S]{0,30}\bcan (i|we|she|he|they)\b/i,
      /\b\d+\s?mg\b[\s\S]{0,30}\b(safe|ok|okay|too (much|high)|allowed|reasonable)\b/i,
      /\b(starting|target|usual|recommended|studied|initial|max\w*)\s+dos\w*/i,
      // Titration and tapering are always about a dose, with or without the word nearby.
      // "Should I titrate up?" is a dosing question and was slipping through ungrounded.
      /\btitrat\w*|\btaper\w*|\bup-?titrat\w*|\bdose.?escalat\w*/i
    ]],
    ['interaction', [
      /\binteract\w*/i,
      /\b(combin\w*|together|alongside|concurrent\w*|co-?administ\w*|on both)\b[\s\S]{0,40}\b(safe|ok|okay|risk\w*|problem\w*|issue\w*|concern\w*|contraindicat\w*)/i,
      /\b(safe|risky|a problem|an issue|dangerous)\b[\s\S]{0,40}\b(together|with|combination|alongside|combined)/i,
      /\bserotonin syndrome|\bqtc?\b|\bcyp\s?\d\w*|\b2d6\b|\b3a4\b|\b1a2\b|\b2c19\b/i
    ]],
    ['contraindication', [
      /\bcontraindicat\w*/i,
      /\b(can|should|must)\s?n[o']t\b[\s\S]{0,30}\b(take|use|prescrib\w*|combin\w*|give|be on)/i,
      /\bforbidden|prohibited|absolutely (not|avoid)/i
    ]],
    ['warnings', [
      /\bwarning\w*|\bprecaution\w*|\bblack ?box\w*|\bboxed warning/i,
      /\bside.?effect\w*|\badverse\s+(effect\w*|reaction\w*|event\w*)|\btoxicit\w*/i,
      /\brisks? of\b/i,
      /\bmonitor\w*\b[\s\S]{0,30}\b(need\w*|requir\w*|should|what|which)/i
    ]],
    ['populations', [
      /\bpregnan\w*|\blactat\w*|\bbreast.?feed\w*|\bnursing\b/i,
      /\brenal\w*|\bhepatic\w*|\bkidney\w*|\bliver\b|\bcreatinine\b/i,
      /\belderly\b|\bgeriatric\w*|\bpediatric\w*|\bchild\w*|\badolescen\w*|\bage \d+/i
    ]],
    ['indication', [
      /\bapprov\w*|\bindicat\w*|\bon.?label\b|\boff.?label\b|\bfda\b/i
    ]]
  ];

  function classifyQuestion(question) {
    var q = String(question || '');
    var classes = [], reasons = [];
    if (!q.trim()) return { needsMedicationFacts: false, classes: [], reasons: [] };
    CLASS_PATTERNS.forEach(function (pair) {
      for (var i = 0; i < pair[1].length; i++) {
        if (pair[1][i].test(q)) {
          if (classes.indexOf(pair[0]) === -1) { classes.push(pair[0]); reasons.push(pair[0] + ': ' + pair[1][i]); }
          return;
        }
      }
    });
    return { needsMedicationFacts: classes.length > 0, classes: classes, reasons: reasons };
  }

  // Which confirmation purpose a question implies. 'dose' is the one that makes a missing dose
  // or an unstated release form worth interrupting for, because those are what pick the label.
  function purposeFor(classes) {
    if (!classes || !classes.length) return null;
    if (classes.indexOf('dosing') > -1) return 'dose';
    if (classes.indexOf('interaction') > -1) return 'interaction';
    return 'grounding';
  }

  // ── 2. The evidence block ─────────────────────────────────────────────────────────────────
  //
  // Kept OUT of the case material on purpose. If label text is pasted into the chart narrative,
  // the model has no way to tell what this patient's clinician documented from what a
  // manufacturer's label says, and neither does anyone reading the answer. Three labelled
  // regions: patient material, retrieved evidence, the question.
  var SECTION_TITLES = {
    dosage_and_administration: 'DOSAGE AND ADMINISTRATION',
    clinical_studies: 'CLINICAL STUDIES',
    use_in_specific_populations: 'USE IN SPECIFIC POPULATIONS',
    contraindications: 'CONTRAINDICATIONS',
    drug_interactions: 'DRUG INTERACTIONS',
    warnings_and_precautions: 'WARNINGS AND PRECAUTIONS',
    warnings_and_cautions: 'WARNINGS AND PRECAUTIONS',
    boxed_warning: 'BOXED WARNING',
    indications_and_usage: 'INDICATIONS AND USAGE'
  };

  var SECTION_CAP = 9000;   // per section; a full DOSAGE section on some labels is enormous

  function buildEvidenceBlock(evidence, opts) {
    opts = opts || {};
    var items = (evidence || []).filter(function (e) { return e && e.sections && e.sections.length; });
    if (!items.length) return '';
    var parts = [
      'RETRIEVED AUTHORITATIVE MEDICATION EVIDENCE',
      '',
      'Verbatim sections of the current FDA-approved product labeling (Structured Product Label),',
      'retrieved from DailyMed for the specific products confirmed for this patient. This is NOT',
      'patient material and NOT your own knowledge. It is the source of record for medication',
      'facts in this answer.'
    ];
    items.forEach(function (e, i) {
      var s = e.source || {};
      parts.push('');
      parts.push('─────────────────────────────────────────────────────────');
      parts.push('EVIDENCE ' + (i + 1) + ' FOR: ' + (e.requested || e.drug));
      parts.push('  product label: ' + (s.label_title || '(title unavailable)'));
      if (e.rxcui)          parts.push('  RxCUI: ' + e.rxcui);
      if (s.setid)          parts.push('  SPL Set ID: ' + s.setid);
      if (s.spl_version)    parts.push('  SPL version: ' + s.spl_version);
      if (s.effective_date) parts.push('  label date: ' + s.effective_date);
      parts.push('  source: DailyMed (NLM), current labeling');
      e.sections.forEach(function (sec) {
        var text = String(sec.text || '').trim();
        var clipped = text.length > SECTION_CAP;
        parts.push('');
        parts.push('  ── ' + (SECTION_TITLES[sec.section] || sec.section.toUpperCase())
          + (sec.loinc ? ' (LOINC ' + sec.loinc + ')' : '') + ' ──');
        parts.push(clipped ? text.slice(0, SECTION_CAP) : text);
        // Same protection the outside-record renderer uses: absence from an excerpt is not
        // absence from the label, and a model told otherwise will answer "the label does not say".
        if (clipped) parts.push('  [TRUNCATED at ' + SECTION_CAP + ' of ' + text.length
          + ' characters. Later text is NOT shown, so do not treat an absence here as an absence in the label.]');
      });
    });
    return parts.join('\n');
  }

  // ── 3. What the model may do with it ──────────────────────────────────────────────────────
  //
  // Two halves, and the second is the one that matters. Telling a model to use the evidence is
  // easy. Telling it what to do when the evidence is MISSING is what stops it quietly answering
  // from memory instead, which is the original defect.
  function groundingRules(classes, gaps) {
    var lines = [];
    lines.push('=== MEDICATION FACTS: USE THE RETRIEVED EVIDENCE, NOT YOUR MEMORY ===');
    lines.push('');
    lines.push('Authoritative label sections were retrieved for this question. For any factual claim');
    lines.push('about a medication (dose, maximum, contraindication, interaction, warning, approved use,');
    lines.push('use in a specific population), the RETRIEVED AUTHORITATIVE MEDICATION EVIDENCE block is');
    lines.push('the source. State the fact as the label states it. Do not supply a number, a limit or a');
    lines.push('contraindication from recall when the evidence block is there to be read.');
    lines.push('');
    lines.push('KEEP THESE APART. They are different facts and collapsing them is the specific error');
    lines.push('this evidence exists to prevent:');
    lines.push('  - the recommended or usual ADULT dose');
    lines.push('  - an explicit labeled MAXIMUM, which exists for some products and populations and not others');
    lines.push('  - the highest dose STUDIED in trials, which is not the same as a labeled maximum');
    lines.push('  - a PEDIATRIC maximum, which is never an adult maximum');
    lines.push('  - dosing that is specific to ONE FORMULATION (extended-release is not immediate-release)');
    lines.push('  - a CONTRAINDICATION (do not use) versus an INTERACTION (use with awareness, adjustment');
    lines.push('    or monitoring). An interaction is not a contraindication. Say which one the label states.');
    lines.push('');
    lines.push('If the label states no explicit maximum, say that it states none, and give what it does');
    lines.push('state. Do not invent a ceiling, and do not present the highest studied dose as a limit.');
    lines.push('Name the population and the formulation whenever you give a number.');
    if (gaps && gaps.length) {
      lines.push('');
      lines.push('EVIDENCE IS MISSING FOR THE FOLLOWING, AND YOU MAY NOT FILL THE GAP FROM MEMORY:');
      gaps.forEach(function (g) {
        lines.push('  - ' + g.drug + ': ' + g.why);
      });
      lines.push('');
      lines.push('For anything that depends on the missing evidence, say plainly that you could not');
      lines.push('retrieve the labeling and what you would need. Reason about everything else normally.');
      lines.push('An honest gap is useful to the clinician. A confident number from recall is the failure');
      lines.push('mode that put this whole mechanism here.');
    }
    return lines.join('\n');
  }

  // ── 4. The inspectable trail ──────────────────────────────────────────────────────────────
  //
  // Four failures look identical in a wrong answer and need completely different fixes: wrong
  // medication identity, right identity but wrong label chosen, right label but the wrong
  // section retrieved, and correct evidence reasoned over badly. The trail separates them.
  function summarizeTrail(evidence) {
    return (evidence || []).map(function (e) {
      var s = e.source || {};
      return {
        requested: e.requested || e.drug,
        status: e.error ? 'failed' : (e.resolution_status || 'resolved'),
        failure: e.error || null,
        rxcui: e.rxcui || null,
        resolved_by: e.resolved_by || null,
        label_title: s.label_title || null,
        setid: s.setid || null,
        spl_version: s.spl_version || null,
        effective_date: s.effective_date || null,
        of_candidates: s.of_candidates || null,
        chosen_because: s.chosen_because || null,
        candidates: e.candidates || null,
        sections: (e.sections || []).map(function (x) {
          return { section: x.section, loinc: x.loinc, chars: String(x.text || '').length };
        })
      };
    });
  }

  // Everything the retrieval could not supply, phrased for the prompt. Four distinct kinds, and
  // the model should say the right one: the identity never resolved, the identity was ambiguous
  // so nothing was used, the label had nothing readable, or the label has no such section.
  function evidenceGaps(evidence, primarySections) {
    var gaps = [];
    var resolved = 0, seen = {};
    (evidence || []).forEach(function (e) {
      var name = e.requested || e.drug;
      // AMBIGUITY IS CHECKED FIRST. An ambiguous result carries an `error` string too, and
      // testing `error` first collapsed every ambiguity into a generic retrieval failure --
      // losing precisely the distinction between "we could not tell which product this is"
      // and "the service was down", which need completely different fixes.
      if (e.resolution_status === 'ambiguous') {
        gaps.push({ drug: name, kind: 'identity_ambiguous',
          why: 'the product could not be identified unambiguously from what was confirmed'
             + (e.candidates && e.candidates.length ? ' (' + e.candidates.length + ' plausible labels)' : '')
             + '. No label was used rather than guessing one.' });
        return;
      }
      if (e.error) { gaps.push({ drug: name, why: e.error, kind: e.failure_kind || 'retrieval_failed' }); return; }
      var have = (e.sections || []).map(function (x) { return x.section; });
      if (!have.length) { gaps.push({ drug: name, kind: 'no_sections', why: 'a label was identified but no requested section could be read from it' }); return; }
      resolved++;
      have.forEach(function (h) { seen[h] = true; });
    });

    // A missing section is judged ACROSS the retrieved labels, not per drug. Fluoxetine's
    // dosing section is not needed to answer "what is the maximum Adderall dose", and demanding
    // every section from every drug produces gap lists that are mostly noise -- which teaches
    // the reader to skip the list where the real failures are reported. A supplementary section
    // is never a gap at all: most labels have no boxed warning, and that is an answer.
    if (resolved) {
      (primarySections || []).forEach(function (sec) {
        if (!seen[sec]) gaps.push({ kind: 'section_missing', drug: 'the retrieved labeling',
          why: 'no retrieved label has a ' + sec + ' section' });
      });
    }
    return gaps;
  }

  var API = { classifyQuestion: classifyQuestion, purposeFor: purposeFor,
              buildEvidenceBlock: buildEvidenceBlock, groundingRules: groundingRules,
              summarizeTrail: summarizeTrail, evidenceGaps: evidenceGaps,
              SECTION_CAP: SECTION_CAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.TBP_RX_GROUNDING = API;
})(typeof window !== 'undefined' ? window : globalThis);

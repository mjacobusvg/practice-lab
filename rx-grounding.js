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

  // ── 1b. QUERY SCOPE: what this question needs, which is not the medication list ───────────
  //
  // The mistake this replaces: "this question needs medication facts" was treated as "this
  // question needs a clinician-confirmed canonical medication list". They are not the same, and
  // conflating them put a two-row reconciliation form in front of a clinician whose note already
  // said, in plain words, "Adderall XR 20 mg every morning" and "fluoxetine 40 mg".
  //
  // Using a medication that today's note states clearly does NOT promote it into canonical
  // confirmed state. It is a QUERY-SCOPED input: good enough to retrieve a label and answer,
  // not a claim that the clinician has ratified a medication list. Canonical confirmation is
  // for state the app will persist, reuse, modify or act on later. It is not the price of
  // admission for answering a question whose inputs are already written down.
  //
  // So the gate is per CLAIM and asks only for a distinction that materially changes the
  // evidence:
  //   "maximum dose" of a drug that comes in IR and XR, with no release form stated  -> ask
  //   "is A + B contraindicated", both named                                          -> do not ask
  //   the same drug appearing as both current and stopped                             -> ask

  // Drugs where the release form changes which label applies, and therefore the dose answer.
  var FORM_SENSITIVE = ['amphetamine_mixed_salts', 'methylphenidate', 'dextroamphetamine',
    'bupropion', 'venlafaxine', 'quetiapine', 'paliperidone', 'carbamazepine', 'divalproex',
    'lithium', 'guanfacine', 'clonidine', 'metformin', 'oxycodone', 'morphine', 'tramadol'];

  // Only a claim about dosing or a formulation-specific fact is changed by the release form.
  // "Is A contraindicated with B" is answered from the same sections either way.
  function classNeedsFormulation(classes) {
    return (classes || []).indexOf('dosing') > -1;
  }

  function resolveQueryScope(opts) {
    opts = opts || {};
    var classes = opts.classes || [];
    var confirmed = opts.confirmed || [];
    var candidates = opts.candidates || [];
    var asks = [], inputs = [], source;

    if (confirmed.length) {
      // A confirmed list is authoritative when one exists. It is not required for one to exist.
      inputs = confirmed.slice();
      source = 'confirmed';
    } else {
      // Anything today's material states as current use. 'unclear' and 'historical' are left
      // out: "we discussed lithium" is not a regimen, and neither is "stopped fluoxetine".
      inputs = candidates.filter(function (c) { return c.proposedStatus === 'current'; });
      source = 'note';
    }

    // A drug stated as current in one place and stopped in another genuinely changes the
    // answer, and no amount of reading will settle it. That is worth asking about.
    var byKey = {};
    candidates.forEach(function (c) {
      var k = c.interactionKey || c.rawName;
      (byKey[k] = byKey[k] || []).push(c);
    });
    if (source === 'note') {
      Object.keys(byKey).forEach(function (k) {
        var group = byKey[k];
        var cur = group.filter(function (c) { return c.proposedStatus === 'current'; });
        var past = group.filter(function (c) { return c.proposedStatus === 'historical'; });
        if (cur.length && past.length) {
          asks.push({ drug: cur[0].rawName, need: 'status',
            why: 'your note describes this as both current and stopped' });
        } else if (!cur.length && group.length && classes.length) {
          // Mentioned but never as current use: not an input, and not an ask either. The
          // question may not be about it at all.
        }
      });
    }

    // The only identity gap worth interrupting for: a release form that would select a
    // different label, on a question whose answer depends on which label.
    if (classNeedsFormulation(classes)) {
      inputs.forEach(function (m) {
        if (m.formulation) return;
        if (FORM_SENSITIVE.indexOf(m.interactionKey) === -1) return;
        asks.push({ drug: m.rawName, need: 'formulation',
          why: 'immediate-release and extended-release have different labeled maximums, and your note does not say which' });
      });
    }

    return { inputs: inputs, source: source, asks: asks,
             sufficient: inputs.length > 0 && asks.length === 0 };
  }

  // ── 1c. IDENTITY GRANULARITY BY CLAIM ────────────────────────────────────────────────────
  //
  // "I found 52 generic fluoxetine labels and cannot tell which manufacturer's bottle she has,
  // therefore I cannot retrieve fluoxetine evidence" is the wrong level of identity for the
  // claim being made. Whether fluoxetine inhibits CYP2D6 is an INGREDIENT-level fact; it is the
  // same in every equivalent label, and PD-Rx versus RemedyRepack has no bearing on it.
  //
  // Whether 60 mg/day is reachable on Adderall XR is a PRODUCT-level fact: extended-release and
  // immediate-release have different labels and different numbers, and getting that wrong is
  // the defect this whole layer exists for.
  //
  //     claim  ->  required identity granularity  ->  appropriate evidence
  //
  // not: every medication claim -> exact manufacturer SPL, or failure.
  function granularityFor(med) {
    // The identity the clinician actually wrote decides it. A named product with a release form
    // is a product-level identity and must resolve as one. A bare ingredient name is an
    // ingredient-level identity, and any authoritative label for that ingredient will answer an
    // ingredient-level question.
    if (med && (med.formulation || med.brand)) return 'product';
    return 'ingredient';
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

  // The Tier 2 block, kept visually and verbally separate from the label. Its whole value is
  // that the clinician can see the figure, see where it came from, and correct it. Presenting it
  // with the same weight as the labeling would throw that away.
  function buildReferenceBlock(refs) {
    if (!refs || !refs.length) return '';
    var parts = [
      'TIER 2: PRACTICAL CLINICAL DOSING REFERENCE (Think Beyond Practice curated table)',
      '',
      'This is NOT product labeling and NOT patient material. It is a curated table of practical',
      'adult ranges, kept because the FDA label frequently does not contain the concept a clinician',
      'means by "the maximum I can go to". Use it for the practical ceiling. Never cite it as the',
      'label, and never let it override a labeled figure.'
    ];
    var anyUnverified = refs.some(function (r) { return !r.entry.verified; });
    refs.forEach(function (r) {
      var e = r.entry;
      parts.push('');
      parts.push('  ' + r.requested + '  (' + e.product + ', ' + (e.population || 'adult') + ')');
      if (e.adultPracticalCeiling) parts.push('    practical ceiling in common use: ' + e.adultPracticalCeiling);
      if (e.labelRecommended)      parts.push('    labeled recommended dose: ' + e.labelRecommended);
      if (e.basis)                 parts.push('    basis: ' + e.basis);
      if (e.note)                  parts.push('    note: ' + e.note);
      parts.push('    status: ' + (e.verified
        ? 'clinician-verified ' + (e.reviewedBy || '') + ' ' + (e.reviewedAt || '')
        : 'NOT clinician-verified'));
    });
    parts.push('');
    parts.push('This table describes why IT holds a figure. It is not a report of what any label');
    parts.push('says. Do not attribute anything here to the labeling: if a fact belongs to a label,');
    parts.push('it is in the Tier 1 evidence block or it was not retrieved.');
    if (anyUnverified) {
      parts.push('');
      parts.push('SOME ENTRIES ABOVE ARE NOT YET CLINICIAN-VERIFIED. Give the figure, because it is what');
      parts.push('the clinician asked for, and say it is a commonly cited practical ceiling rather than a');
      parts.push('labeled one. Do not present an unverified entry as authoritative or as labeling.');
    }
    return parts.join('\n');
  }

  // ── 3. What the model may do with it ──────────────────────────────────────────────────────
  //
  // Two halves, and the second is the one that matters. Telling a model to use the evidence is
  // easy. Telling it what to do when the evidence is MISSING is what stops it quietly answering
  // from memory instead, which is the original defect.
  function groundingRules(classes, gaps) {
    var lines = [];
    lines.push('=== MEDICATION FACTS: ANSWER THE CLINICIAN, USING THE EVIDENCE ===');
    lines.push('');
    lines.push('ANSWER THE QUESTION THEY ASKED, NOT THE QUESTION THE DOCUMENT ANSWERS.');
    lines.push('"What is the maximum dose I can go to" is a clinical question. It is NOT the question');
    lines.push('"does this label contain a field called adult maximum". If the label states no explicit');
    lines.push('maximum, that is one useful fact among several, not the answer and never the opening line.');
    lines.push('');
    lines.push('LEAD WITH THE MOST USEFUL ACCURATE ANSWER. QUALIFY SECOND. A clinician mid-visit needs the');
    lines.push('number and the shape of the decision first; the provenance matters and belongs right after.');
    lines.push('Opening with what a document does not contain is a non-answer, and a non-answer is worse');
    lines.push('than useless here because it costs the clinician the time it took to read it.');
    lines.push('');
    lines.push('THE FIRST SENTENCE ANSWERS THE QUESTION. If they asked for a maximum, the first sentence');
    lines.push('contains a number and what kind of number it is. Not the labeled dose they are already');
    lines.push('on, not a description of the label, not a preamble. The shape is:');
    lines.push('');
    lines.push('    <the practical answer, with its category>. <what the label states, and what it does');
    lines.push('    not>. <the other categories that matter>. <what it means for this decision>.');
    lines.push('');
    lines.push('DO NOT UPGRADE THE SOURCE\'S HEDGING. If the label says an interaction MAY increase');
    lines.push('exposure, say may or can. Do not turn it into "has likely increased" for this patient:');
    lines.push('that converts a general pharmacologic statement into a patient-specific claim nobody');
    lines.push('measured. The same goes downward: do not soften a stated contraindication into a caution.');
    lines.push('');
    lines.push('TWO KINDS OF SOURCE, WITH DIFFERENT AUTHORITY:');
    lines.push('');
    lines.push('  1. THE RETRIEVED LABEL is authoritative for what a label establishes: the labeled or');
    lines.push('     recommended dose, an explicit labeled maximum WHERE THE LABEL STATES ONE, the doses');
    lines.push('     studied, contraindications, interactions, warnings, and use in specific populations.');
    lines.push('     Do not contradict it, and do not attribute to it a figure it does not contain.');
    lines.push('');
    lines.push('  2. ESTABLISHED CLINICAL PRACTICE, which you may supply from your own knowledge, clearly');
    lines.push('     marked as such: the practical ceiling in common use, typical titration, how an');
    lines.push('     interaction is actually managed, what most clinical references give as a maximum.');
    lines.push('     Grounding exists to stop you INVENTING facts. It does not exist to stop you');
    lines.push('     SYNTHESIZING an answer. Say plainly when a figure is common clinical practice rather');
    lines.push('     than a labeled one, and do not dress practice up as labeling or labeling as practice.');
    lines.push('');
    lines.push('NAME THE CATEGORY OF EVERY NUMBER YOU GIVE. These are different facts and presenting one');
    lines.push('as another is the specific error this evidence exists to prevent:');
    lines.push('  - the FDA recommended or usual ADULT dose');
    lines.push('  - an explicit FDA-labeled MAXIMUM, which exists for some products and populations and');
    lines.push('    not others. Where the label states none, say so; do NOT invent one, and do NOT');
    lines.push('    present the highest studied dose as though it were one.');
    lines.push('  - the highest dose STUDIED in trials');
    lines.push('  - the PRACTICAL CEILING in common clinical use, which is often what the clinician means');
    lines.push('  - a PEDIATRIC maximum, which is never an adult maximum');
    lines.push('  - dosing specific to ONE FORMULATION (extended-release is not immediate-release)');
    lines.push('Always name the population and the formulation alongside a number.');
    lines.push('');
    lines.push('CONTRAINDICATION versus INTERACTION. A contraindication means do not use. An interaction');
    lines.push('means use with awareness, adjustment or monitoring. Say which one the evidence supports,');
    lines.push('name the mechanism if it is known, and say what it means for the decision in front of');
    lines.push('them. "Not contraindicated" on its own is not an answer to a clinician weighing a change.');
    lines.push('');
    lines.push('IF AUTHORITATIVE SOURCES DISAGREE on a ceiling, give the values and say which is which.');
    lines.push('Disagreement between good sources is information. It is not an inability to answer.');
    if (gaps && gaps.length) {
      lines.push('');
      lines.push('RETRIEVAL WAS INCOMPLETE:');
      gaps.forEach(function (g) { lines.push('  - ' + g.drug + ': ' + g.why); });
      lines.push('');
      lines.push('For those, you may NOT state what the labeling says, quote it, or imply you read it.');
      lines.push('You MAY still answer the clinical question from established practice, said plainly as');
      lines.push('that, and you should: a clinician who asked a real question is owed a real answer plus');
      lines.push('an honest note about what could not be verified. Say briefly what you could not');
      lines.push('retrieve and what would confirm it. Do NOT make the failed retrieval the headline.');
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
        lookups: e.lookups || null,
        unmapped_codes: e.unmapped_codes || null,
        attempts: e.attempts || null,
        writes: e.writes || null,
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
              resolveQueryScope: resolveQueryScope, FORM_SENSITIVE: FORM_SENSITIVE,
              granularityFor: granularityFor,
              buildEvidenceBlock: buildEvidenceBlock, buildReferenceBlock: buildReferenceBlock,
              groundingRules: groundingRules,
              summarizeTrail: summarizeTrail, evidenceGaps: evidenceGaps,
              SECTION_CAP: SECTION_CAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.TBP_RX_GROUNDING = API;
})(typeof window !== 'undefined' ? window : globalThis);

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
      /\b(how (much|high|far)|go(ing)? higher|push (it |the dose )?(up|higher)|increas\w*|titrat\w*|taper\w*|reduc\w*|lower)\b[\s\S]{0,40}\b(dose|dosing|mg|on (the|her|his|their|this|that|it)\b)/i,
      /\bhow (much|high|far)\b[\s\S]{0,30}\bcan (i|we|she|he|they|you)\b/i,
      // "How high can I go on this?" is how the question is actually asked, and it matched
      // nothing: the pattern above wanted "on the/her/his/their" and the clinician wrote "on
      // this". No class matched, so no retrieval ran, so every answer to it came from memory
      // while the trail reported no gap because nothing had been asked for.
      /\b(can|could|should) (i|we|you)\b[\s\S]{0,20}\b(go|push|move|take|bump)\b[\s\S]{0,20}\b(up|higher|further|above|beyond|more)/i,
      /\b(room|headroom|space) (to|for)\b[\s\S]{0,20}\b(go|increas\w*|titrat\w*|push|move)/i,
      /\bhow (high|far|much)\b[\s\S]{0,40}\b(go|push|take|increas\w*)\b/i,
      /\bgo (up|higher|above|beyond)\b/i,
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


  // ── POPULATION SPLIT ──────────────────────────────────────────────────────────────────────
  // A dosing section states several populations' figures in one run of prose, and three times
  // now the model has answered an ADULT question with a PEDIATRIC number: Adderall 30 mg (the
  // original defect), Concerta 54 mg (Pass B run 1, where 72 is the adult figure), and the
  // lithium range given as one range when the label gives an acute one and a maintenance one.
  // Retrieval was correct every time. The figures were simply adjacent, and adjacency is enough.
  //
  // So the separation is made BEFORE the model sees the text, and every dose figure arrives
  // carrying the population it belongs to.
  //
  // THE INVARIANT: nothing may be lost. The segments must reassemble into the source exactly,
  // or the split is judged wrong and the section is presented whole. A parser that silently
  // drops the paragraph holding the real maximum is worse than no parser, and "specificity
  // present in the source is never destroyed" holds for a fix as much as for anything else.
  var POP_PATTERNS = [
    ['pediatric', /\b(p(?:a)?ediatric|children|child|adolescen|infant|neonat)\b/i],
    // NOT a bare "65 years": "Adults 18 to 65 years" is an age RANGE whose end happens to be 65,
    // and matching it tagged Concerta's adult row as geriatric, taking the adult 72 mg/day figure
    // with it. Geriatric has to be said, not inferred from a boundary.
    ['geriatric', /\b(geriatric|elderly|older adults?|65 years (?:and|or) (?:older|above|over)|over 65)\b/i],
    ['adult',     /\badults?\b/i]
  ];

  function populationOf(heading) {
    var hits = [];
    POP_PATTERNS.forEach(function (p) {
      if (p[1].test(heading) && hits.indexOf(p[0]) === -1) hits.push(p[0]);
    });
    if (!hits.length) return 'unspecified';
    // A heading naming more than one population is reported as naming more than one. Picking
    // the first would be inventing a precision the heading does not have.
    return hits.sort().join(' and ');
  }

  function splitByPopulation(text) {
    var src = String(text || '');
    var marks = [], re = /(^|\s)(\d{1,2}\.\d{1,2})\s+(?=[A-Z])/g, m;
    while ((m = re.exec(src)) !== null) marks.push(m.index + m[1].length);
    if (marks.length < 2) return { segments: null, why: 'no numbered subsection structure' };

    var segs = [];
    if (marks[0] > 0) {
      segs.push({ population: 'unspecified', heading: '(text before the first numbered subsection)',
                  text: src.slice(0, marks[0]) });
    }
    for (var i = 0; i < marks.length; i++) {
      var body = src.slice(marks[i], (i + 1 < marks.length) ? marks[i + 1] : src.length);
      // The heading is only used to classify. The body is kept whole either way.
      var head = body.slice(0, 90).split(/[:\n]/)[0];
      segs.push({ population: populationOf(head), heading: head.trim(), text: body });
    }
    var rejoined = segs.map(function (x) { return x.text; }).join('');
    if (rejoined !== src) return { segments: null, why: 'segments did not reassemble to the source' };
    if (!segs.some(function (x) { return x.population !== 'unspecified'; })) {
      return { segments: null, why: 'no subsection names a population' };
    }
    return { segments: segs, why: null };
  }


  // ── POPULATION-TAGGED FIGURE INDEX ────────────────────────────────────────────────────────
  // splitByPopulation only works when the label puts populations in SUBSECTION HEADINGS, which
  // Adderall XR does ("2.1 Adults", "2.2 Pediatric Patients") and Concerta does not. Concerta's
  // subsections are named for clinical situation, and the age bands live inside a dosing TABLE:
  // "Children 6-12 years ... 54 mg/day ... Adults ... 72 mg/day". The split saw no population in
  // any heading, correctly declined rather than guessing, and did nothing at all -- and Concerta
  // then answered 54 mg/day to an adult question in one run of five.
  //
  // So the association is made per FIGURE instead of per section: for each dose figure, the
  // nearest population term BEFORE it, which is how both a table row and an ordinary sentence
  // read. A figure with no population term near it is reported as unclear, never guessed.
  //
  // This is a DERIVED ARTIFACT, not label text, and is labelled as such where it is rendered. It
  // is additive: the section is still presented in full, unchanged, above it.
  var FIGURE_RE = /\b\d[\d.,]*\s*(?:mg|mcg|g|mEq)(?:\s*\/\s*(?:day|kg\/day|kg|m2|dose))?/gi;
  var POP_NEAR = 260;      // how far back a population term still governs a figure
  var MAX_FIGURES = 40;

  function populationTaggedFigures(text) {
    var src = String(text || '');
    if (!src) return [];
    var seen = {}, out = [], m;
    FIGURE_RE.lastIndex = 0;
    while ((m = FIGURE_RE.exec(src)) !== null && out.length < MAX_FIGURES) {
      var figure = m[0].replace(/\s+/g, ' ').toLowerCase();
      var from = Math.max(0, m.index - POP_NEAR);
      var before = src.slice(from, m.index);
      // The LAST population term before the figure governs it. In a table that is the row's own
      // label; in a sentence it is the subject. An earlier one has been superseded.
      var best = null, bestAt = -1;
      POP_PATTERNS.forEach(function (pp) {
        var re = new RegExp(pp[1].source, 'gi'), mm, at = -1;
        while ((mm = re.exec(before)) !== null) at = mm.index;
        if (at > bestAt) { bestAt = at; best = pp[0]; }
      });
      var population = (bestAt === -1) ? 'unclear' : best;
      var key = figure + '|' + population;
      if (seen[key]) continue;
      seen[key] = true;
      out.push({
        figure: figure,
        population: population,
        // The basis, so a wrong association is visible rather than authoritative.
        context: src.slice(Math.max(0, m.index - 90), m.index + m[0].length + 30)
                    .replace(/\s+/g, ' ').trim()
      });
    }
    return out;
  }

  // Only sections whose whole job is to state figures per population. Splitting prose that
  // merely mentions children would add noise without removing a confusion.
  var POPULATION_SPLIT_SECTIONS = { dosage_and_administration: true };

  function buildEvidenceBlock(evidence, opts) {
    opts = opts || {};
    var items = (evidence || []).filter(function (e) { return e && e.sections && e.sections.length; });
    if (!items.length) return '';
    var substituted = items.filter(function (e) { return e && e.identity_note; });
    var parts = [
      'RETRIEVED AUTHORITATIVE MEDICATION EVIDENCE',
      '',
      'Verbatim sections of the current FDA-approved product labeling (Structured Product Label),',
      'retrieved from DailyMed for the specific products confirmed for this patient. This is NOT',
      'patient material and NOT your own knowledge. It is the source of record for medication',
      'facts in this answer.'
    ];
    if (substituted.length) {
      parts.push('');
      parts.push('NOT EVERY ITEM BELOW IS THE LABEL FOR THE PRODUCT THAT WAS ASKED ABOUT. Where an');
      parts.push('item carries an IDENTITY SUBSTITUTION line, the product named has no current label');
      parts.push('of its own and what follows is labeling for an equivalent product. Say so in your');
      parts.push('answer. Do not write "the <asked-about product> label states" about text that did');
      parts.push('not come from that product\'s label.');
    }
    items.forEach(function (e, i) {
      var s = e.source || {};
      parts.push('');
      parts.push('─────────────────────────────────────────────────────────');
      parts.push('EVIDENCE ' + (i + 1) + ' FOR: ' + (e.requested || e.drug));
      // The substitution is stated HERE, next to the label it applies to, because a clinician
      // reading "the current label says 12/50" has no way to know the product has no current
      // label. Retrieval succeeding is not the same as the answer being about what was asked.
      if (e.identity_note) {
        parts.push('  IDENTITY SUBSTITUTION: ' + e.identity_note);
        parts.push('  Attribute anything you take from this item to that labeling, by name, not to '
          + (e.requested || e.drug) + '.');
      }
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
        var shown = clipped ? text.slice(0, SECTION_CAP) : text;
        var split = POPULATION_SPLIT_SECTIONS[sec.section] ? splitByPopulation(shown)
                                                           : { segments: null };
        if (split.segments) {
          parts.push('  This section is separated below by the population each part applies to.');
          parts.push('  A figure in one block is NOT a figure for another population. State the');
          parts.push('  population alongside every dose you give, and never give a figure from a');
          parts.push('  block whose population does not match the patient being asked about.');
          split.segments.forEach(function (g) {
            parts.push('');
            parts.push('  [POPULATION: ' + g.population + ']'
              + (g.heading ? '  ' + g.heading : ''));
            parts.push(g.text);
          });
        } else {
          parts.push(shown);
        }
        // Always, whether or not the section split: the figures are indexed with the population
        // nearest each one. A heading-based split cannot see a dosing table, and a dosing table
        // is where the confusable numbers usually live.
        if (POPULATION_SPLIT_SECTIONS[sec.section]) {
          var tagged = populationTaggedFigures(shown);
          if (tagged.length) {
            parts.push('');
            parts.push('  ── DOSE FIGURES ABOVE, EACH WITH THE POPULATION NEAREST IT ──');
            parts.push('  DERIVED, not label text: built by locating the nearest population term');
            parts.push('  before each figure. It exists because these figures sit next to each other');
            parts.push('  and have been confused before. Do not present a figure listed under one');
            parts.push('  population as a figure for another. Where a figure says unclear, the section');
            parts.push('  did not state a population near it, so do not assign it one. If this index');
            parts.push('  and the section text above disagree, THE SECTION TEXT WINS.');
            tagged.forEach(function (f) {
              parts.push('    ' + f.figure + '  ->  ' + f.population + '   ...' + f.context + '...');
            });
          }
        }
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

  // ── DOCUMENTED WEIGHT ─────────────────────────────────────────────────────────────────────
  // A weight-based ceiling is not a number until someone supplies a weight. Pass B answered
  // "4,200 mg/day" and "4,800 mg/day" as divalproex ceilings, which are 60 mg/kg/day times 70 kg
  // and 80 kg. No weight appeared anywhere in the note. At 50 kg the real ceiling is 3,000, so
  // the answer overstated available headroom by forty percent using a patient parameter nobody
  // recorded.
  //
  // This is not the same as computing 120 mg/day from a documented "60 mg bid". That input was
  // written down. The difference is whether the clinician supplied the number or the model did.
  var LB_PER_KG = 2.20462;
  function kgToLb(kg) { return Math.round(kg * LB_PER_KG); }
  function lbToKg(lb) { return Math.round((lb / LB_PER_KG) * 10) / 10; }

  // Returns null, or { kg, lb, text, unit }. BOTH units, always, whichever one was written down.
  // Labels dose in mg/kg and every scale in the building reads pounds, so a clinician handed
  // only the kilogram figure has to do the conversion themselves, mid-visit, which is the exact
  // tax this is supposed to remove.
  function documentedWeight(text) {
    // Strip mg/kg expressions FIRST. "60 mg/kg/day" contains "kg" and would otherwise read as a
    // documented weight, which would defeat the entire check on exactly the answers it is for.
    var t = String(text || '').replace(/\d[\d.,]*\s*(?:mg|mcg|g)\s*\/\s*kg/gi, ' ');
    var m = t.match(/\b(\d{2,3}(?:\.\d)?)\s*(kg|kgs|kilo|kilos|kilogram|kilograms)\b/i);
    if (m) {
      var kg = parseFloat(m[1]);
      return { kg: kg, lb: kgToLb(kg), unit: 'kg',
               text: kgToLb(kg) + ' lb (' + kg + ' kg)' };
    }
    m = t.match(/\b(\d{2,3}(?:\.\d)?)\s*(lb|lbs|pound|pounds)\b/i);
    if (m) {
      var lb = parseFloat(m[1]);
      return { kg: lbToKg(lb), lb: lb, unit: 'lb',
               text: lb + ' lb (' + lbToKg(lb) + ' kg)' };
    }
    return null;
  }

  function groundingRules(classes, gaps, opts) {
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
    lines.push('     BUT A NUMBER IS NOT SYNTHESIS. You may describe practice in words from your own');
    lines.push('     knowledge. You may NOT state a specific dose figure that appears neither in the');
    lines.push('     retrieved label nor in the clinical reference block above. Marking it "off-label"');
    lines.push('     or "in common practice" does not license it: a recalled number is exactly the');
    lines.push('     thing that put a wrong maximum in front of a clinician, and a reader cannot tell');
    lines.push('     a remembered figure from a sourced one. So say "some clinicians do exceed the');
    lines.push('     labeled ceiling, and I have no sourced figure for how far" rather than naming a');
    lines.push('     number you cannot point at. Describing the practice is useful. Inventing its');
    lines.push('     number is the defect.');
    lines.push('');
    // ── weight-based ceilings ──
    var w = (opts && opts.weight) || null;
    // Accepts the object documentedWeight returns, or a plain string from an older caller.
    var weight = w ? (typeof w === 'string' ? { text: w, kg: null, lb: null } : w) : null;
    if (!classes || classes.indexOf('dosing') > -1) {
      lines.push('A WEIGHT-BASED CEILING IS NOT A NUMBER UNTIL SOMEONE SUPPLIES A WEIGHT.');
      if (weight) {
        lines.push('This encounter documents a weight of ' + weight.text + '. You may convert a');
        lines.push('mg/kg ceiling to a daily dose using it, and when you do, state the weight you');
        lines.push('used in the same sentence so the clinician can see which number the answer');
        lines.push('rests on.');
        lines.push('GIVE THE WEIGHT IN POUNDS FIRST, with the kilograms in parentheses, every time.');
        lines.push('Labels dose per kilogram and every scale in the building reads pounds, so a');
        lines.push('clinician handed only the kilogram figure has to convert it themselves while');
        lines.push('they are trying to think about the patient.');
      } else {
        lines.push('THIS ENCOUNTER DOCUMENTS NO WEIGHT. Give the ceiling per kilogram and say the');
        lines.push('weight is not documented.');
        lines.push('');
        lines.push('Say that, and stop. The whole answer is: "the labeled maximum for acute mania is');
        lines.push('60 mg/kg/day; no weight is documented for this patient, so I cannot convert that');
        lines.push('into a patient-specific mg/day ceiling."');
        lines.push('');
        lines.push('Do NOT work it out at weights you pick. A patient-specific question does not want');
        lines.push('figures belonging to imaginary patients, and "at 70 kg it would be 4,200, at 50 kg');
        lines.push('3,000" clutters the answer with two numbers that are not about anyone in the');
        lines.push('room. Give examples only if the clinician asks for them.');
        lines.push('');
        lines.push('And never present a figure as this patient\'s. "Works out to about 3,000 to 4,000');
        lines.push('mg/day for most adults" reads as careful and is not conditional at all: it asserts');
        lines.push('a range for this patient from a weight nobody recorded, and a reader cannot tell');
        lines.push('it from a documented one.');
      }
      lines.push('');
    }
    lines.push('DO NOT SUPPLY A PATIENT CHARACTERISTIC THE ENCOUNTER DOES NOT DOCUMENT. Weight is');
    lines.push('the one with arithmetic attached, and it is not the only one. Sex, age, pregnancy');
    lines.push('status, renal and hepatic function all gate labeled figures, and a label threshold');
    lines.push('that differs between two groups is not resolved by guessing which group this');
    lines.push('patient is in.');
    lines.push('');
    lines.push('Observed: an answer referred to a patient as "he" throughout a note that never');
    lines.push('stated a sex, then cited a thrombocytopenia threshold of 110 mcg/mL in females and');
    lines.push('135 in males. Had the guess been wrong, the practical ceiling handed to the');
    lines.push('clinician was 25 mcg/mL too high.');
    lines.push('');
    lines.push('So: write "the patient" or "they" when the encounter does not say, give BOTH sides');
    lines.push('of a characteristic-dependent threshold, and name which characteristic decides it.');
    lines.push('Naming the missing input is useful. Guessing it and carrying on is not.');
    lines.push('');
    lines.push('SHOW THE INPUTS FOR ANY FIGURE YOU CALCULATE. A computed number is not covered by');
    lines.push('the evidence above, because the evidence contains its inputs and not the result.');
    lines.push('One answer called 72 mg/day "one 18 mg increment above the current 36 mg", which is');
    lines.push('two increments, not one. Stating the arithmetic is what makes that visible instead');
    lines.push('of authoritative.');
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
              buildEvidenceBlock: buildEvidenceBlock,
    splitByPopulation: splitByPopulation,
    populationTaggedFigures: populationTaggedFigures,
    populationOf: populationOf, buildReferenceBlock: buildReferenceBlock,
              groundingRules: groundingRules,
    documentedWeight: documentedWeight,
    kgToLb: kgToLb, lbToKg: lbToKg,
              summarizeTrail: summarizeTrail, evidenceGaps: evidenceGaps,
              SECTION_CAP: SECTION_CAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.TBP_RX_GROUNDING = API;
})(typeof window !== 'undefined' ? window : globalThis);

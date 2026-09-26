// The wired Discern path, end to end, with the network stubbed.
//
// This container cannot reach DailyMed or RxNav, so the live acceptance run happens in the
// browser. What CAN be proven here is everything between the clinician's question and the
// request that leaves, and everything between the response and the prompt: gating, evidence
// separation, the grounding rules, the trail, the result record, and every failure mode.
//
// The thing this is really guarding: that a retrieval failure does not quietly become an
// answer from model memory.

const { readFileSync } = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = readFileSync('ai-scribe-practice.html', 'utf8');
const VOCAB = require('../rx-vocabulary.js');
const DETECT = require('../rx-detect.js');
const GROUND = require('../rx-grounding.js');

// Slice: encounter state + medication logic + grounding client + the context reader.
const i = html.indexOf('function TBP_ENCOUNTER_BLANK(){');
const j = html.indexOf('\nfunction tbpRsnUpdateCtx(');
assert.ok(i > 0 && j > i);
const CORE = html.slice(i, j);
// Slice: the Discern runner itself, as shipped.
const ri = html.indexOf('function tbpRsnTrailHtml(');
const rj = html.indexOf("\ndocument.getElementById('rsn-go')");
assert.ok(ri > 0 && rj > ri, 'could not slice tbpRunReason');
const RUNNER = html.slice(ri, rj);
assert.ok(/async function tbpRunReason\(question\)/.test(RUNNER));
assert.ok(/async function tbpRunReasonNow/.test(RUNNER));

const ADDERALL_DOSAGE =
  '2.1 Adults: 20 mg/day. In some cases 40 mg/day may be appropriate.\n' +
  '2.2 Pediatric Patients 6 to 12 years: doses above 30 mg/day have not been studied.';
const ADDERALL_STUDIES = 'Adults were studied at 20, 40 and 60 mg/day in controlled trials.';
const FLX_INTERACTIONS = 'CYP2D6 inhibition. Monitor when combined with sympathomimetics.';
const FLX_CONTRA = 'Contraindicated with MAOIs and with pimozide or thioridazine.';

function makeEnv(opts = {}) {
  const els = {};
  const el = (id, v) => (els[id] = { value: v || '', innerHTML: '', textContent: '', style: {},
                                     disabled: false, classList: { add() {}, remove() {}, contains: () => false },
                                     insertAdjacentHTML(pos, h) { this.innerHTML += h; },
                                     addEventListener() {}, closest: () => null,
                                     querySelectorAll: () => [],
                                     scrollIntoView() {}, parentNode: null, focus() {} });
  ['raw', 'context', 'hpi-out', 'assess-out', 'therapy-out', 'plan-out', 'rsn-out', 'rsn-msg',
   'rsn-go', 'rsn-q', 'meds-rows', 'meds-why', 'meds-msg', 'meds-confirm', 'meds-modal',
   'focus-overlay', 'focus-note'].forEach((k) => el(k));
  els.raw.value = opts.note || '';
  const bodies = {};

  const captured = { calls: [], fetches: [] };
  const sandbox = {
    console, Date, JSON, Math, Object, Array, String, Promise, RegExp, Error, isFinite, parseInt,
    setTimeout: (f) => f, clearTimeout: () => {},
    window: { TBP_RX_VOCAB: VOCAB, TBP_RX_DETECT: DETECT, TBP_RX_GROUNDING: GROUND },
    TBP_RX_VOCAB: VOCAB, TBP_RX_DETECT: DETECT, TBP_RX_GROUNDING: GROUND,
    authToken: 'test-token',
    esc: (x) => String(x),
    rsnLog: [], rsnLast: null,
    tbpRsnUpdateCtx: () => {},
    tbpRsnBlockHtml: (n) => { bodies['rsn-body-' + n] = el('rsn-body-' + n); return '<div></div>'; },
    reasonSystem: (grounding) => 'BASE-PROMPT' + (grounding ? '\n' + grounding : ''),
    document: {
      getElementById: (id) => els[id] || bodies[id] || null,
      querySelectorAll: () => [], querySelector: () => null
    },
    fetch: async (url, init) => {
      captured.fetches.push({ url, init, body: JSON.parse(init.body) });
      if (opts.fetchImpl) return opts.fetchImpl(url, init);
      return { ok: true, status: 200, json: async () => opts.evidenceResponse };
    },
    callAPI: async (system, messages) => {
      captured.calls.push({ system, user: messages[0].content });
      return opts.answer || 'ANSWER';
    }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(CORE + '\n' + RUNNER, ctx);
  ctx.__captured = captured;
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);

const RESOLVED = {
  evidence: [
    { requested: 'Adderall XR', drug: 'Adderall XR', resolution_status: 'resolved', rxcui: '541878',
      sections: [{ section: 'dosage_and_administration', loinc: '34068-7', text: ADDERALL_DOSAGE },
                 { section: 'clinical_studies', loinc: '34092-8', text: ADDERALL_STUDIES }],
      source: { label_title: 'ADDERALL XR- dextroamphetamine saccharate capsule, extended release',
                setid: 'set-adderall-xr', spl_version: 41, effective_date: '20240712',
                of_candidates: 7, chosen_because: 'title matches full query; both extended-release (score 135 of 7 candidates)' } },
    { requested: 'fluoxetine', drug: 'fluoxetine', resolution_status: 'resolved', rxcui: '4493',
      sections: [{ section: 'drug_interactions', loinc: '34073-7', text: FLX_INTERACTIONS },
                 { section: 'contraindications', loinc: '34070-3', text: FLX_CONTRA }],
      source: { label_title: 'FLUOXETINE- fluoxetine hydrochloride capsule', setid: 'set-flx',
                spl_version: 12, effective_date: '20231101', of_candidates: 31,
                chosen_because: 'title matches full query; neither extended-release (score 130 of 31 candidates)' } }
  ],
  wanted_sections: ['dosage_and_administration', 'clinical_studies', 'use_in_specific_populations',
                    'contraindications', 'boxed_warning'],
  primary_sections: ['dosage_and_administration', 'contraindications']
};

const CONFIRM = `tbpMedApplyConfirmation([
  { rawName: 'Adderall XR', dose: '20 mg', formulation: 'extended-release',
    interactionKey: 'amphetamine_mixed_salts', status: 'current' },
  { rawName: 'fluoxetine', dose: '40 mg', interactionKey: 'fluoxetine', status: 'current' }]);`;

const Q = 'What is the maximum Adderall dose I can go to, and is that combination contraindicated?';

let checks = 0, failures = 0;
function test(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}\n  ${e.message}`); }
}
const sync = (ctx, code) => { let e; run(ctx, `__p = (async()=>{ ${code} })().then(()=>{},function(x){ __err = x; });`);
  return new Promise((res) => setImmediate(() => setImmediate(() => { e = ctx.__err; res(e); }))); };

// Drives the async runner to completion.
async function ask(ctx, question) {
  await vm.runInContext(`tbpRunReason(${JSON.stringify(question)})`, ctx);
}

(async function main() {

  // ---- gating -------------------------------------------------------------------------------
  await (async () => {
    const ctx = makeEnv({ note: 'Takes Adderall XR 20 mg.', evidenceResponse: RESOLVED });
    await ask(ctx, 'What am I missing?');
    test('a non-medication question retrieves nothing', () => {
      assert.strictEqual(ctx.__captured.fetches.length, 0, 'no evidence call');
      const call = ctx.__captured.calls[0];
      assert.ok(!/RETRIEVED AUTHORITATIVE/.test(call.user), 'no evidence block');
      assert.strictEqual(call.system, 'BASE-PROMPT', 'the base prompt is untouched');
    });
  })();

  // ---- THE REGRESSION: a note that already says it must not trigger a confirmation form ------
  await (async () => {
    const ctx = makeEnv({ note: '34yo woman, follow-up for ADHD and anxiety.\n'
      + 'Currently taking Adderall XR 20 mg every morning.\n'
      + 'PCP started fluoxetine 40 mg two weeks ago for anxiety.', evidenceResponse: RESOLVED });
    await ask(ctx, Q);
    test('NOTHING CONFIRMED but the note is explicit: it just answers', () => {
      // The whole point. "Adderall XR 20 mg every morning" and "fluoxetine 40 mg" are written
      // down in current-use language. Requiring the clinician to ratify a medication list
      // before reading what they wrote is exposing an internal state requirement as though it
      // were a clinical one.
      assert.strictEqual(ctx.__captured.fetches.length, 1, 'it retrieves');
      assert.strictEqual(ctx.__captured.calls.length, 1, 'and answers, with no card');
      assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.__captured.fetches[0].body.drugs)),
        ['Adderall XR', 'fluoxetine'], 'read straight from the note');
    });

    test('reading the note does NOT promote anything into canonical state', () => {
      assert.strictEqual(run(ctx, 'tbpEncounterState.medications.current.length'), 0,
        'reading is not confirming');
      assert.strictEqual(run(ctx, 'tbpEncounterState.medications.confirmedAt'), null);
    });

    test('the answer records that it was grounded on the note, not on a confirmed list', () => {
      const rec = run(ctx, "tbpLatestResult('discern')");
      assert.strictEqual(rec.record.meta.medicationSource, 'note');
      assert.ok(rec.record.inputs.notedMedications, 'declared as note-scoped');
      assert.strictEqual(rec.status, 'current', 'and still verifiable against the note later');
    });

    test('editing the note out from under a note-grounded answer marks it stale', () => {
      run(ctx, "document.getElementById('raw').value = 'Currently taking Adderall XR 30 mg every morning.';");
      assert.strictEqual(run(ctx, "tbpLatestResult('discern').status"), 'stale');
    });
  })();

  // ---- a confirmed list is used when one exists, and is not required for one to exist --------
  await (async () => {
    const ctx = makeEnv({ note: 'Takes Adderall XR 20 mg. PCP started fluoxetine 40 mg.', evidenceResponse: RESOLVED });
    run(ctx, CONFIRM);
    await ask(ctx, Q);
    test('with meds confirmed, the question runs straight through with no card', () => {
      assert.strictEqual(ctx.__captured.calls.length, 1, 'one model call');
      assert.strictEqual(ctx.__captured.fetches.length, 1, 'one evidence call');
    });

    test('only drug names and fact classes leave the browser', () => {
      const sent = ctx.__captured.fetches[0].body;
      assert.deepStrictEqual(sent.drugs, ['Adderall XR', 'fluoxetine']);
      assert.ok(sent.classes.includes('dosing') && sent.classes.includes('contraindication'));
      const flat = JSON.stringify(sent);
      assert.ok(!/PCP|34yo|patient/i.test(flat), 'NO PHI may cross this boundary: ' + flat);
    });

    test('the evidence service is called with the session token, not a shared secret', () => {
      assert.strictEqual(ctx.__captured.fetches[0].init.headers.Authorization, 'Bearer test-token');
      assert.ok(/drug-evidence/.test(ctx.__captured.fetches[0].url));
    });

    test('the prompt has three labelled regions, evidence NOT blended into the chart', () => {
      const u = ctx.__captured.calls[0].user;
      const p = u.indexOf('PATIENT / ENCOUNTER MATERIAL');
      const e = u.indexOf('RETRIEVED AUTHORITATIVE MEDICATION EVIDENCE');
      const q = u.indexOf('THE CLINICIAN ASKS:');
      assert.ok(p > -1 && e > p && q > e, `order should be patient, evidence, question: ${p}/${e}/${q}`);
    });

    test('the label text and its provenance reach the model', () => {
      const u = ctx.__captured.calls[0].user;
      ['doses above 30 mg/day have not been studied', '20, 40 and 60 mg/day',
       'set-adderall-xr', 'ADDERALL XR-', '20240712', '541878',
       FLX_CONTRA, 'set-flx'].forEach((x) => assert.ok(u.indexOf(x) > -1, 'missing: ' + x));
    });

    test('the grounding rules are attached to the SYSTEM prompt, keeping the base intact', () => {
      const sys = ctx.__captured.calls[0].system;
      assert.ok(sys.startsWith('BASE-PROMPT'), 'the existing Discern stance is not replaced');
      assert.ok(/PEDIATRIC maximum, which is never an adult maximum/.test(sys));
      assert.ok(/An interaction is not a contraindication/.test(sys));
      assert.ok(/highest dose STUDIED/.test(sys));
    });

    test('the answer is recorded with its evidence trail and declared inputs', () => {
      const rec = run(ctx, "tbpLatestResult('discern')");
      assert.ok(rec, 'a discern result was recorded');
      assert.strictEqual(rec.status, 'current');
      assert.strictEqual(rec.record.meta.grounded, true);
      const t = rec.record.meta.evidence;
      assert.strictEqual(t.length, 2);
      assert.strictEqual(t[0].setid, 'set-adderall-xr');
      assert.strictEqual(t[0].spl_version, 41);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(t[0].sections.map((s) => s.section))),
        ['dosage_and_administration', 'clinical_studies']);
      assert.strictEqual(rec.record.meta.gaps.length, 0);
    });

    test('resolution is stored as DERIVED metadata, never inside the confirmed record', () => {
      const med = run(ctx, 'tbpEncounterState.medications.current[0]');
      assert.strictEqual(med.rxcui, null, 'the clinician confirmed a product, not an RxCUI');
      assert.strictEqual(med.identityStatus, 'unresolved');
      const d = run(ctx, 'tbpEncounterState.derived.identity');
      const key = Object.keys(d).find((k) => /adderall xr/.test(k));
      assert.ok(key, 'a derived identity entry exists');
      assert.strictEqual(d[key].rxcui, '541878');
      assert.strictEqual(d[key].setid, 'set-adderall-xr');
      assert.strictEqual(d[key].authority, 'noncanonical');
      assert.strictEqual(d[key].identitySource, 'RxNorm + DailyMed');
    });

    test('a dose answer goes stale when the regimen changes', () => {
      run(ctx, "tbpMedApplyConfirmation([{rawName:'Adderall XR', dose:'30 mg', formulation:'extended-release', status:'current'}]);");
      assert.strictEqual(run(ctx, "tbpLatestResult('discern').status"), 'stale');
    });
  })();

  // ---- failure modes: never fall back to memory -------------------------------------------------
  const failCases = [
    ['the evidence service returns nothing',
     { ok: true, status: 200, json: async () => ({ evidence: [], wanted_sections: [] }) },
     (sys) => assert.ok(!/RETRIEVED AUTHORITATIVE/.test(sys))],
    ['the evidence service errors',
     { ok: false, status: 502, json: async () => ({ error: 'upstream timeout' }) },
     (sys, user) => {
       assert.ok(/may not fill the gap from memory/i.test(sys), 'the model is told not to guess');
       assert.ok(/Adderall XR: evidence service returned 502/.test(sys), 'named, with the reason');
       assert.ok(!/RETRIEVED AUTHORITATIVE/.test(user), 'no empty evidence heading');
     }]
  ];
  for (const [label, resp, check] of failCases) {
    const ctx = makeEnv({ note: 'x', fetchImpl: async () => resp });
    run(ctx, CONFIRM);
    await ask(ctx, Q);
    test(label + ' -> gap, not memory', () => {
      assert.strictEqual(ctx.__captured.calls.length, 1, 'it still answers the rest of the question');
      check(ctx.__captured.calls[0].system, ctx.__captured.calls[0].user);
    });
  }

  await (async () => {
    const AMBIG = { evidence: [{ requested: 'Adderall', drug: 'Adderall', resolution_status: 'ambiguous',
      failure_kind: 'identity_ambiguous', error: 'the closest label is a different release form from the confirmed product',
      candidates: [{ title: 'ADDERALL XR-...', score: 65 }, { title: 'ADDERALL-...', score: 60 }] }],
      wanted_sections: ['dosage_and_administration'], primary_sections: ['dosage_and_administration'] };
    // Bare "Adderall" on a DOSE question never reaches retrieval: the confirmation gate stops
    // first, because IR and XR have different maximums. Proven separately below. Here the gate
    // is satisfied and the SERVER finds the identity ambiguous.
    const ctx = makeEnv({ note: 'x', evidenceResponse: AMBIG });
    run(ctx, "tbpMedApplyConfirmation([{rawName:'Adderall', dose:'20 mg', formulation:'immediate-release', interactionKey:'amphetamine_mixed_salts', status:'current'}]);");
    await ask(ctx, 'What is the max dose?');
    test('MULTIPLE PLAUSIBLE LABELS -> refuses, names it, does not answer from memory', () => {
      const sys = ctx.__captured.calls[0].system;
      assert.ok(/identified unambiguously|could not be identified/.test(sys));
      assert.ok(/may not fill the gap from memory/i.test(sys));
      assert.ok(!/RETRIEVED AUTHORITATIVE/.test(ctx.__captured.calls[0].user),
        'an ambiguous identity contributes no evidence at all');
      const d = run(ctx, 'tbpEncounterState.derived.identity');
      const k = Object.keys(d)[0];
      assert.strictEqual(d[k].status, 'ambiguous', 'the ambiguity is recorded, not discarded');
    });
  })();

  await (async () => {
    const PARTIAL = { evidence: [RESOLVED.evidence[0],
      { requested: 'fluoxetine', drug: 'fluoxetine', resolution_status: 'failed',
        failure_kind: 'label_not_found', error: 'no SPL on file for RXCUI 4493' }],
      wanted_sections: ['dosage_and_administration', 'clinical_studies'], primary_sections: ['dosage_and_administration'] };
    const ctx = makeEnv({ note: 'x', evidenceResponse: PARTIAL });
    run(ctx, CONFIRM);
    await ask(ctx, Q);
    test('ONLY ONE OF TWO resolves: the good evidence is used, the gap is named', () => {
      const u = ctx.__captured.calls[0].user, sys = ctx.__captured.calls[0].system;
      assert.ok(/ADDERALL XR-/.test(u), 'the resolved label is still used');
      assert.ok(!/FLUOXETINE-/.test(u), 'the unresolved one contributes nothing');
      assert.ok(/fluoxetine: no SPL on file/.test(sys), 'and is named as a gap');
      assert.ok(/may not fill the gap from memory/i.test(sys));
    });
  })();

  await (async () => {
    const NOSEC = { evidence: [{ requested: 'Adderall XR', drug: 'Adderall XR', resolution_status: 'resolved',
      rxcui: '541878', sections: [{ section: 'dosage_and_administration', loinc: '34068-7', text: ADDERALL_DOSAGE }],
      source: { label_title: 'ADDERALL XR-...', setid: 's', spl_version: 41, effective_date: '20240712' } }],
      wanted_sections: ['dosage_and_administration', 'contraindications'], primary_sections: ['dosage_and_administration', 'contraindications'] };
    const ctx = makeEnv({ note: 'x', evidenceResponse: NOSEC });
    run(ctx, "tbpMedApplyConfirmation([{rawName:'Adderall XR', dose:'20 mg', formulation:'extended-release', status:'current'}]);");
    await ask(ctx, Q);
    test('RIGHT LABEL, MISSING SECTION is its own gap', () => {
      const sys = ctx.__captured.calls[0].system;
      assert.ok(/no retrieved label has a contraindications section/.test(sys));
      assert.ok(/ADDERALL XR/.test(ctx.__captured.calls[0].user), 'the sections it does have are still used');
    });
  })();

  // ---- the confirmation gate stops the unanswerable BEFORE retrieval ---------------------------
  await (async () => {
    const ctx = makeEnv({ note: 'Takes Adderall 20 mg every morning.', evidenceResponse: RESOLVED });
    await ask(ctx, 'What is the max dose?');
    test('FORMULATION UNRESOLVED on a dose question is the ONE thing worth asking', () => {
      assert.strictEqual(ctx.__captured.fetches.length, 0, 'no lookup against an unknown formulation');
      assert.strictEqual(ctx.__captured.calls.length, 0, 'and no answer yet');
      const scope = run(ctx, `TBP_RX_GROUNDING.resolveQueryScope({ classes:['dosing'],
        confirmed: [], candidates: tbpMedScan() })`);
      assert.strictEqual(scope.asks.length, 1);
      assert.strictEqual(scope.asks[0].need, 'formulation');
      assert.ok(/different labeled maximums/.test(scope.asks[0].why));
    });
  })();

  await (async () => {
    const ctx = makeEnv({ note: 'Takes Adderall 20 mg every morning and fluoxetine 40 mg.', evidenceResponse: RESOLVED });
    await ask(ctx, 'Is that combination contraindicated?');
    test('the SAME bare Adderall needs no asking for a contraindication question', () => {
      // The release form does not change which contraindications section applies. Asking here
      // would be friction with no effect on the answer.
      assert.strictEqual(ctx.__captured.fetches.length, 1);
      assert.strictEqual(ctx.__captured.calls.length, 1);
    });
  })();

  await (async () => {
    const ctx = makeEnv({ note: 'Stopped fluoxetine last year. Restarted fluoxetine 40 mg last month.',
                          evidenceResponse: RESOLVED });
    await ask(ctx, 'Any interactions?');
    test('a drug described as BOTH current and stopped is worth asking about', () => {
      assert.strictEqual(ctx.__captured.calls.length, 0, 'no answer until the conflict is settled');
      const scope = run(ctx, `TBP_RX_GROUNDING.resolveQueryScope({ classes:['interaction'],
        confirmed: [], candidates: tbpMedScan() })`);
      assert.ok(scope.asks.some((a) => a.need === 'status'));
    });
  })();

  await (async () => {
    const ctx = makeEnv({ note: 'Previously stopped Concerta after five days. Takes fluoxetine 40 mg.',
                          evidenceResponse: RESOLVED });
    await ask(ctx, 'Any interactions?');
    test('a drug mentioned only as stopped is not an input and not an ask', () => {
      assert.strictEqual(ctx.__captured.fetches.length, 1);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.__captured.fetches[0].body.drugs)), ['fluoxetine'],
        'a stopped drug is not part of the current regimen');
    });
  })();

  await (async () => {
    const ctx = makeEnv({ note: 'Doing well, no changes.', evidenceResponse: RESOLVED });
    await ask(ctx, 'Any interactions?');
    test('NO CONFIRMED MEDICATIONS is a gap, not a licence to answer from memory', () => {
      assert.strictEqual(ctx.__captured.fetches.length, 0, 'nothing to look up');
      assert.strictEqual(ctx.__captured.calls.length, 1, 'it still answers the rest');
      const sys = ctx.__captured.calls[0].system;
      assert.ok(/may not fill the gap from memory/i.test(sys),
        'without this the question silently becomes an ungrounded one');
      assert.ok(/no current medication has been confirmed/.test(sys));
      assert.ok(!/RETRIEVED AUTHORITATIVE/.test(ctx.__captured.calls[0].user));
    });
  })();

  console.log(`\n${checks - failures}/${checks} passed`);
  if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
})();

// Regression proof for the getEncounterContext() / renderCaseContext() refactor.
//
// The refactor must not change one byte of what tbpCaseContext() returns, because that string is
// the case context for every clinical prompt in the Scribe: Discern, prep, the ADHD framework
// builder, the mid-visit delta. A silent wording change there is a silent change to clinical
// output that no visible test would catch.
//
// So this does not test the new code against expectations I wrote down. It extracts the ACTUAL
// pre-refactor tbpCaseContext() from git, runs both against the same stubbed DOM, and asserts the
// {text, have} pair is identical — over hand-built branch cases and then 4000 random states.

const { execSync } = require('child_process');
const vm = require('vm');
const assert = require('assert');

// Values come back from a vm realm, so their Object/Array prototypes are not this realm's and
// deepStrictEqual rejects structurally identical values. Compare the plain data.
const plain = (v) => JSON.parse(JSON.stringify(v));
const deepEq = (a, b, m) => assert.deepStrictEqual(plain(a), plain(b), m);

const HTML = 'ai-scribe-practice.html';
// The last commit before the refactor. Pinned, not HEAD: once the refactor is committed, HEAD
// contains the new code and there is nothing left to compare against.
const BASE = process.env.CTX_BASE_REF || '9b6e832f39280ad6bcf9df0d650bcf4c19ee8e4e';

function slice(src, startNeedle, endNeedle) {
  const i = src.indexOf(startNeedle);
  assert.ok(i >= 0, 'missing start marker: ' + startNeedle);
  const j = src.indexOf(endNeedle, i);
  assert.ok(j >= 0, 'missing end marker: ' + endNeedle);
  return src.slice(i, j);
}

const oldHtml = execSync(`git show ${BASE}:${HTML}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const newHtml = require('fs').readFileSync(HTML, 'utf8');

const oldFn = slice(oldHtml, 'function tbpCaseContext(){', '\nfunction tbpRsnUpdateCtx(');
const newFns = slice(newHtml, 'function getEncounterContext(){', '\nfunction tbpRsnUpdateCtx(');

assert.ok(/function tbpCaseContext\(\)\{ return renderCaseContext/.test(newFns),
  'new source must still define the tbpCaseContext wrapper');
assert.ok(!/function getEncounterContext/.test(oldHtml),
  `${BASE} already contains the refactor; set CTX_BASE_REF to a pre-refactor commit`);

// ---- DOM stub -------------------------------------------------------------------------------
// Only what the two functions actually touch: getElementById().value, classList.contains on the
// overlay, style.display on the plain note, and querySelectorAll for the section textareas.
function makeSandbox(state) {
  const els = {};
  const put = (id, value) => { els[id] = { value: value == null ? '' : value }; };
  put('raw', state.raw);
  put('context', state.context);
  put('hpi-out', state.hpi);
  put('assess-out', state.assess);
  put('therapy-out', state.therapy);
  put('plan-out', state.plan);

  if (state.overlayPresent !== false) {
    els['focus-overlay'] = { classList: { contains: (c) => c === 'open' && !!state.overlayOpen } };
  }
  if (state.focusNotePresent !== false) {
    els['focus-note'] = { value: state.focusNote == null ? '' : state.focusNote,
                          style: { display: state.focusNoteHidden ? 'none' : '' } };
  }

  const sections = (state.sections || []).map((v) => ({ value: v }));

  const sandbox = {
    document: {
      getElementById: (id) => els[id] || null,
      querySelectorAll: (sel) => {
        assert.strictEqual(sel, '#focus-sections .wn-ta', 'unexpected selector: ' + sel);
        return sections;
      }
    }
  };
  if ('visitType' in state)     sandbox.visitType = state.visitType;
  if ('prepSnapshot' in state)  sandbox.prepSnapshot = state.prepSnapshot;
  if ('prepChecklist' in state) sandbox.prepChecklist = state.prepChecklist;
  if ('tbpSources' in state)    sandbox.tbpSources = state.tbpSources;
  if ('adhdFw' in state)        sandbox.adhdFw = state.adhdFw;
  return sandbox;
}

function runOld(state) {
  const ctx = vm.createContext(makeSandbox(state));
  vm.runInContext(oldFn + '\n;__out = tbpCaseContext();', ctx);
  return ctx.__out;
}
function runNew(state) {
  const ctx = vm.createContext(makeSandbox(state));
  vm.runInContext(newFns + '\n;__out = tbpCaseContext(); __ctx = getEncounterContext();', ctx);
  return { out: ctx.__out, ctx: ctx.__ctx };
}

let checks = 0, failures = 0;
function same(label, state) {
  checks++;
  const a = runOld(state);
  const b = runNew(state).out;
  try {
    assert.strictEqual(b.text, a.text, 'text differs');
    deepEq(b.have, a.have, 'have differs');
  } catch (e) {
    failures++;
    console.error(`\nFAIL ${label}: ${e.message}`);
    if (b.text !== a.text) {
      const al = a.text.split('\n'), bl = b.text.split('\n');
      for (let i = 0; i < Math.max(al.length, bl.length); i++) {
        if (al[i] !== bl[i]) { console.error(`  line ${i}\n  old: ${JSON.stringify(al[i])}\n  new: ${JSON.stringify(bl[i])}`); break; }
      }
    } else {
      console.error(`  old have: ${JSON.stringify(a.have)}\n  new have: ${JSON.stringify(b.have)}`);
    }
  }
}

const LONG = 'x'.repeat(20000);
const src = (o) => Object.assign({ id: 'd1', name: 'Doc', text: '', review: '', useForPrep: true, chars: 0 }, o);

// ---- branch cases ---------------------------------------------------------------------------
same('empty state', {});
same('visit type unset explicitly', { visitType: '', raw: 'note' });
same('new eval', { visitType: 'new_eval', raw: 'note' });
same('follow-up', { visitType: 'follow_up', raw: 'note' });
same('odd visit type falls to follow-up label', { visitType: 'whatever', raw: 'note' });

same('raw only', { raw: '  patient reports better sleep  ' });
same('raw whitespace only', { raw: '   \n  ' });
same('no overlay element at all', { overlayPresent: false, raw: 'r', sections: ['s'] });
same('no focus-note element', { focusNotePresent: false, overlayOpen: true, raw: 'r' });
same('overlay closed, focus note has text -> sections/raw win', { overlayOpen: false, focusNote: 'STALE', raw: 'r' });
same('overlay open, focus note visible -> focus wins', { overlayOpen: true, focusNote: ' live text ', sections: ['s1'], raw: 'r' });
same('overlay open, focus note HIDDEN (sections mode) -> sections win', { overlayOpen: true, focusNoteHidden: true, focusNote: 'STALE', sections: ['A', 'B'], raw: 'r' });
same('overlay open, focus note empty -> sections win', { overlayOpen: true, focusNote: '   ', sections: ['A'], raw: 'r' });
same('overlay open, focus empty, no sections -> raw', { overlayOpen: true, focusNote: '', raw: 'fallback' });
same('sections present but all blank -> raw', { sections: ['', '  ', '\n'], raw: 'fallback' });
same('sections with blanks interleaved', { sections: ['A', '', ' B ', '   '], raw: 'r' });
same('sections only, no raw', { sections: ['only section'] });

same('hpi only', { raw: 'r', hpi: 'H' });
same('assess only', { raw: 'r', assess: 'A' });
same('therapy only', { raw: 'r', therapy: 'T' });
same('plan only', { raw: 'r', plan: 'P' });
same('all four drafted', { raw: 'r', hpi: 'H', assess: 'A', therapy: 'T', plan: 'P' });
same('drafted, no working note', { hpi: 'H', plan: 'P' });
same('drafted whitespace is dropped', { raw: 'r', hpi: '   ', assess: 'A' });

same('prior note only', { context: 'last time...' });
same('prior note + everything', { raw: 'r', hpi: 'H', context: 'last' });

same('prep snapshot only', { raw: 'r', prepSnapshot: 'snap' });
same('prep checklist only (no bit)', { raw: 'r', prepChecklist: ['q1', 'q2'] });
same('prep both', { raw: 'r', prepSnapshot: 'snap', prepChecklist: ['q1'] });
same('prep checklist empty array', { raw: 'r', prepChecklist: [] });
same('prep snapshot empty string', { raw: 'r', prepSnapshot: '' });

same('sources: none', { raw: 'r', tbpSources: [] });
same('sources: not used for prep', { raw: 'r', tbpSources: [src({ text: 'body', useForPrep: false })] });
same('sources: empty text skipped', { raw: 'r', tbpSources: [src({ text: '' })] });
same('sources: review preferred over text', { raw: 'r', tbpSources: [src({ text: 'full body', review: 'the review' })] });
same('sources: review preferred even over a long body', { raw: 'r', tbpSources: [src({ text: LONG, review: 'the review' })] });
same('sources: under cap', { raw: 'r', tbpSources: [src({ text: 'short body' })] });
same('sources: exactly at cap', { raw: 'r', tbpSources: [src({ text: 'y'.repeat(14000) })] });
same('sources: one over cap', { raw: 'r', tbpSources: [src({ text: 'y'.repeat(14001) })] });
same('sources: far over cap', { raw: 'r', tbpSources: [src({ text: LONG })] });
same('sources: numbering skips unused', {
  raw: 'r',
  tbpSources: [src({ name: 'A', text: 'a' }), src({ name: 'skip', text: 'b', useForPrep: false }),
               src({ name: 'C', text: LONG }), src({ name: 'D', text: 'd', review: 'rev' })]
});
same('sources: three records pluralizes', {
  raw: 'r', tbpSources: [src({ name: '1', text: '1' }), src({ name: '2', text: '2' }), src({ name: '3', text: '3' })]
});
same('tbpSources undefined -> caught', { raw: 'r' });

same('everything at once', {
  visitType: 'new_eval', overlayOpen: true, focusNoteHidden: true, sections: ['S1', 'S2'], raw: 'r',
  hpi: 'H', assess: 'A', therapy: 'T', plan: 'P', context: 'prior',
  prepSnapshot: 'snap', prepChecklist: ['c1', 'c2'], adhdFw: 'framework text',
  tbpSources: [src({ name: 'Neuropsych', text: LONG }), src({ name: 'Old chart', text: 'brief', review: 'rev' })]
});

// ---- fuzz -----------------------------------------------------------------------------------
function rnd(seedRef) { seedRef.s = (seedRef.s * 1103515245 + 12345) & 0x7fffffff; return seedRef.s / 0x7fffffff; }
const seed = { s: 20260926 };
const pick = (a) => a[Math.floor(rnd(seed) * a.length) % a.length];
const maybe = (v) => (rnd(seed) < 0.5 ? v : '');

for (let n = 0; n < 4000; n++) {
  const nSrc = Math.floor(rnd(seed) * 4);
  const sources = [];
  for (let i = 0; i < nSrc; i++) {
    sources.push(src({
      name: pick(['A', 'Doc with (parens)', '', 'Ünïcode ✓', 'x'.repeat(80)]),
      text: pick(['', 'short', 'y'.repeat(13999), 'y'.repeat(14000), 'y'.repeat(14001), LONG]),
      review: maybe(pick(['rev', 'multi\nline\nreview'])),
      useForPrep: rnd(seed) < 0.75
    }));
  }
  const state = {
    visitType: pick([undefined, '', 'new_eval', 'follow_up']),
    overlayPresent: rnd(seed) < 0.9,
    overlayOpen: rnd(seed) < 0.5,
    focusNotePresent: rnd(seed) < 0.9,
    focusNoteHidden: rnd(seed) < 0.5,
    focusNote: pick(['', '   ', 'focus body', 'multi\n\nline focus']),
    sections: pick([[], [''], ['A'], ['A', 'B'], ['', 'B', '  '], ['a\nb', 'c']]),
    raw: pick(['', '  ', 'raw body', 'raw\nwith\nlines']),
    hpi: maybe('HPI text'), assess: maybe('Assessment text'),
    therapy: maybe('Therapy text'), plan: maybe('Plan text'),
    context: maybe(pick(['prior note', 'prior\nmultiline'])),
    prepSnapshot: maybe('snapshot'),
    prepChecklist: pick([undefined, [], ['q1'], ['q1', 'q2', 'q3']]),
    tbpSources: rnd(seed) < 0.85 ? sources : undefined
  };
  if (state.visitType === undefined) delete state.visitType;
  if (state.prepChecklist === undefined) delete state.prepChecklist;
  if (state.tbpSources === undefined) delete state.tbpSources;
  same('fuzz#' + n, state);
}

// ---- the structured object itself -------------------------------------------------------------
// Byte-identical prose is the safety property. These assert the object is actually usable, which
// is the point of the refactor: a consumer must be able to read a field without parsing prose.
function structural(label, fn) {
  checks++;
  try { fn(); } catch (e) { failures++; console.error(`\nFAIL ${label}: ${e.message}`); }
}

structural('note.from reports the winning branch', () => {
  assert.strictEqual(runNew({ overlayOpen: true, focusNote: 'f', raw: 'r' }).ctx.note.from, 'focus');
  assert.strictEqual(runNew({ overlayOpen: true, focusNoteHidden: true, sections: ['s'], raw: 'r' }).ctx.note.from, 'sections');
  assert.strictEqual(runNew({ raw: 'r' }).ctx.note.from, 'raw');
  assert.strictEqual(runNew({}).ctx.note.from, 'none');
});

structural('drafted sections are addressable individually', () => {
  const c = runNew({ hpi: 'H', assess: 'A', therapy: 'T', plan: 'P' }).ctx;
  deepEq(c.drafted, { hpi: 'H', assessment: 'A', therapy: 'T', plan: 'P' });
});

structural('sources keep FULL text, uncapped and unfiltered', () => {
  const c = runNew({ tbpSources: [src({ name: 'N', text: LONG }), src({ name: 'skip', text: 'b', useForPrep: false })] }).ctx;
  assert.strictEqual(c.sources.length, 2, 'renderer filters useForPrep, the context must not');
  assert.strictEqual(c.sources[0].text.length, LONG.length, 'the 14k cap is a rendering decision');
  assert.strictEqual(c.sources[1].useForPrep, false);
});

structural('prep is a real array, not a joined string', () => {
  const c = runNew({ prepChecklist: ['q1', 'q2'], prepSnapshot: 's' }).ctx;
  deepEq(c.prep.checklist, ['q1', 'q2']);
  assert.strictEqual(c.prep.snapshot, 's');
});

structural('mutating the context does not mutate app state', () => {
  const list = ['q1'];
  const c = runNew({ prepChecklist: list }).ctx;
  c.prep.checklist.push('injected');
  deepEq(list, ['q1'], 'prepChecklist must be copied, not aliased');
});

structural('unresolved fields are declared, not silently absent', () => {
  const u = runNew({}).ctx.unresolved;
  ['medications', 'medicationChanges', 'adverseEffects', 'vitals', 'labs', 'screenersCompleted', 'diagnoses']
    .forEach((k) => assert.ok(typeof u[k] === 'string' && u[k].length, 'missing unresolved.' + k));
});

structural('results is an empty return channel', () => {
  deepEq(runNew({}).ctx.results, {});
});

structural('missing globals do not throw', () => {
  const c = runNew({}).ctx;
  assert.strictEqual(c.visitType, null);
  assert.strictEqual(c.framework, null);
  deepEq(c.sources, []);
});

console.log(`\n${checks - failures}/${checks} passed`);
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }

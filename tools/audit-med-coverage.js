#!/usr/bin/env node
// Offline half of the psych medication grounding coverage audit.
// Stages 1-2 (vocabulary, detection, formulation, status, granularity, Tier 2 need) run here.
// Stages 3-6 (RxNorm resolve, SPL choose, section retrieve, answer) need live DailyMed and must
// run in the browser. Read-only: this changes nothing.
//   node tools/audit-med-coverage.js
const V = require('../rx-vocabulary.js');
const D = require('../rx-detect.js');
const G = require('../rx-grounding.js');
const R = require('../rx-clinical-reference.js');

// Michael's list, written the way a clinician writes it in a note.
const DRUGS = [
  ['SSRI/SNRI', 'fluoxetine 40 mg daily'],
  ['SSRI/SNRI', 'sertraline 100 mg daily'],
  ['SSRI/SNRI', 'escitalopram 10 mg daily'],
  ['SSRI/SNRI', 'fluvoxamine 100 mg nightly'],
  ['SSRI/SNRI', 'Effexor XR 150 mg daily'],
  ['SSRI/SNRI', 'venlafaxine XR 150 mg daily'],
  ['SSRI/SNRI', 'duloxetine 60 mg daily'],
  ['other AD',  'Wellbutrin XL 300 mg every morning'],
  ['other AD',  'bupropion SR 150 mg bid'],
  ['other AD',  'mirtazapine 15 mg nightly'],
  ['other AD',  'trazodone 50 mg nightly'],
  ['stimulant', 'Adderall XR 20 mg every morning'],
  ['stimulant', 'Adderall 10 mg bid'],
  ['stimulant', 'Vyvanse 40 mg every morning'],
  ['stimulant', 'Concerta 36 mg daily'],
  ['stimulant', 'methylphenidate 10 mg bid'],
  ['nonstim',   'atomoxetine 40 mg daily'],
  ['nonstim',   'guanfacine ER 2 mg nightly'],
  ['nonstim',   'clonidine ER 0.1 mg nightly'],
  ['antipsych', 'aripiprazole 10 mg daily'],
  ['antipsych', 'quetiapine 100 mg nightly'],
  ['antipsych', 'Seroquel XR 300 mg nightly'],
  ['antipsych', 'olanzapine 10 mg nightly'],
  ['antipsych', 'risperidone 2 mg nightly'],
  ['antipsych', 'lurasidone 40 mg daily'],
  ['antipsych', 'cariprazine 3 mg daily'],
  ['antipsych', 'ziprasidone 60 mg bid'],
  ['antipsych', 'clozapine 300 mg nightly'],
  ['mood stab', 'lithium 900 mg nightly'],
  ['mood stab', 'lamotrigine 200 mg daily'],
  ['mood stab', 'divalproex ER 1000 mg nightly'],
  ['mood stab', 'carbamazepine XR 400 mg bid'],
  ['mood stab', 'oxcarbazepine 600 mg bid'],
  ['sedative',  'lorazepam 0.5 mg tid prn'],
  ['sedative',  'clonazepam 1 mg bid'],
  ['sedative',  'alprazolam 0.5 mg tid prn'],
  ['sedative',  'zolpidem 10 mg nightly'],
  ['sedative',  'doxepin 6 mg nightly'],
  ['combo',     'Suboxone 8 mg/2 mg sublingual daily'],
  ['combo',     'Symbyax 6/25 mg nightly'],
  ['LAI',       'Abilify Maintena 400 mg IM monthly'],
  ['LAI',       'Invega Sustenna 156 mg IM monthly']
];

const NOTE = (phrase) => 'Currently taking ' + phrase + '.';
const rows = [];
DRUGS.forEach(([cls, phrase]) => {
  const c = D.detect(NOTE(phrase), { vocab: V });
  const r = {
    cls, phrase,
    found: c.length === 1 ? 'yes' : (c.length === 0 ? 'NO' : c.length + ' hits'),
    name: c[0] ? c[0].rawName : '',
    key: c[0] ? c[0].interactionKey : '',
    form: c[0] ? (c[0].formulation || '-') : '',
    dose: c[0] ? (c[0].dose || '-') : '',
    status: c[0] ? c[0].proposedStatus : '',
    gran: c[0] ? G.granularityFor(c[0]) : '',
    tier2: c[0] && R.lookup(c[0]) ? 'row' : '-'
  };
  rows.push(r);
});

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(pad('class', 10) + pad('written', 34) + pad('detected', 18) + pad('key', 24)
  + pad('form', 20) + pad('dose', 10) + pad('status', 10) + pad('gran', 11) + 'T2');
console.log('-'.repeat(140));
rows.forEach(r => console.log(pad(r.cls, 10) + pad(r.phrase, 34)
  + pad(r.found === 'yes' ? r.name : '** ' + r.found + ' **', 18)
  + pad(r.key, 24) + pad(r.form, 20) + pad(r.dose, 10) + pad(r.status, 10) + pad(r.gran, 11) + r.tier2));

const bad = rows.filter(r => r.found !== 'yes');
console.log('\n' + (rows.length - bad.length) + '/' + rows.length + ' detected cleanly');
if (bad.length) console.log('NOT CLEAN: ' + bad.map(b => b.phrase + ' (' + b.found + ')').join(' | '));

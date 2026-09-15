/* Offline checks for the Clinical Simulation Lab and its adversarial harness.
 *
 *   node test/sim-harness-checks.mjs
 *
 * Makes no API calls. Two invariants, both of which have to hold or the
 * harness result is worthless:
 *
 *   PARITY   The harness must drive the patient through the SAME protocol the
 *            lab ships — same proxy, same models, same token budgets, same
 *            seeding of the opening turn, same transcript serialization, same
 *            debrief prompt, and the same shared prompt file. A harness that
 *            has quietly drifted from the lab is measuring a program nobody
 *            uses. Several sessions may be editing these files in parallel,
 *            so this is worth re-running before trusting any harness output.
 *
 *   FIDELITY The quote checker is the one criterion that decides mechanically
 *            whether the coach fabricates evidence, so it gets its own unit
 *            tests: verbatim and fragments pass, paraphrase and invention and
 *            speaker swaps fail.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lab = readFileSync(join(root, 'practice-lab-clinical.html'), 'utf8');
const har = readFileSync(join(root, 'practice-lab-clinical-harness.html'), 'utf8');

let failures = 0;
const ok  = (n, extra='') => console.log('  PASS  ' + n + (extra ? '  ' + extra : ''));
const bad = (n, extra='') => { failures++; console.log('  FAIL  ' + n + (extra ? '  ' + extra : '')); };
const is  = (cond, n, extra='') => cond ? ok(n, extra) : bad(n, extra);

console.log('\nPARITY — harness runs the protocol the lab ships');

for (const [name, re] of [
  ['proxy endpoint', /var PROXY = '(.*?)';/],
  ['patient model',  /var PATIENT_MODEL = '(.*?)';/],
  ['coach model',    /var COACH_MODEL   = '(.*?)';/],
]) {
  const a = (lab.match(re) || [])[1], b = (har.match(re) || [])[1];
  is(a && a === b, name, `lab=${a} harness=${b}`);
}

is(/max_tokens: 700/.test(lab) && /PATIENT_MODEL, 700,/.test(har),
   'patient turn budget is 700 tokens in both');
is(/max_tokens: 3000/.test(lab) && /COACH_MODEL, 3000,/.test(har),
   'debrief budget is 3000 tokens in both');

const seed = /msgs\.push\(\{role:'assistant', content:JSON\.stringify\(\{say:sc\.opening, readiness:sc\.state\.readiness, alliance:sc\.state\.alliance, note:'opening position'\}\)\}\);/;
is(seed.test(lab) && seed.test(har), 'opening is seeded as the same assistant JSON turn');

const ser = /\(t\.who==='clinician' \? 'CLINICIAN' : 'PATIENT'\) \+ ' \[' \+ i \+ '\]: ' \+ t\.text/;
is(ser.test(lab) && ser.test(har), 'transcript is serialized identically for the coach');

/* The two files name the transcript variable differently (transcriptText() vs
   tText). That is the only licensed difference; the prompt text around it must
   match character for character. */
const promptOf = s => {
  const m = s.match(/'SCENARIO: '\+sc\.title[\s\S]*?'Code the CLINICIAN turns only\. Return the JSON object\.';/);
  return m ? m[0].replace(/transcriptText\(\)/g, '«T»').replace(/\btText\b/g, '«T»').replace(/\s+/g, ' ') : null;
};
const pl = promptOf(lab), ph = promptOf(har);
is(pl && pl === ph, 'debrief user prompt is character for character identical');

const core = /<script src="\/clinical-sim-core\.js"><\/script>/;
is(core.test(lab) && core.test(har), 'both pages load the shared prompt file');
is(/SIMCORE\.patientSystem\(sc\)/.test(lab) && /SIMCORE\.patientSystem\(sc\)/.test(har) &&
   /SIMCORE\.coachSystem\(\)/.test(lab)     && /SIMCORE\.coachSystem\(\)/.test(har),
   'both pages call the shared patient and coach prompts, neither holds a copy');
is(!/You are playing a single simulated patient/.test(lab) && !/You are playing a single simulated patient/.test(har),
   'neither page has re-inlined a private copy of the patient prompt');

/* Every scenario must have all three arms, all the same length, or the arms
   are not comparable. */
const coreSrc = readFileSync(join(root, 'clinical-sim-core.js'), 'utf8');
const scriptSrc = readFileSync(join(root, 'clinical-sim-scripts.js'), 'utf8');
const sandbox = {};
new Function('g', coreSrc + '\ng.SIMCORE = SIMCORE;')(sandbox);
new Function('g', scriptSrc + '\ng.SIMSCRIPTS = SIMSCRIPTS;')(sandbox);
for (const sc of sandbox.SIMCORE.SCENARIOS.mi) {
  const arms = sandbox.SIMSCRIPTS[sc.id];
  if (!arms) { bad(`scripts exist for ${sc.id}`); continue; }
  const lens = ['bad', 'neutral', 'good'].map(a => (arms[a] || []).length);
  is(lens.every(n => n > 0) && new Set(lens).size === 1,
     `${sc.id}: three arms of equal length`, `bad/neutral/good = ${lens.join('/')}`);
}

console.log('\nFIDELITY — the fabrication detector');

/* Pulled from the harness page so the tests exercise the shipped code. */
const grab = (src, sig) => {
  const i = src.indexOf(sig);
  if (i === -1) throw new Error('not found: ' + sig);
  let d = 0, j = i;
  for (;; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
  return src.slice(i, j + 1);
};
const qc = {};
new Function('g', grab(har, 'function norm(s){') + '\n' + grab(har, 'function checkQuotes(transcript, d){') + '\ng.checkQuotes = checkQuotes;')(qc);

const T = [
  { who: 'patient',   text: "Look, before you start. I've made up my mind." },
  { who: 'clinician', text: 'You came anyway, even though you had already decided and you knew roughly how this conversation was going to go. That took something.' },
  { who: 'patient',   text: "I guess. I mean, I said I'd come." },
  { who: 'clinician', text: 'Would it be alright if I told you what I know about the options here? You can throw all of it out.' },
  { who: 'patient',   text: 'Fine. I want to hear it, I guess. I do not want to go back in the hospital.' },
];
const q = (label, d, expect) => {
  const r = qc.checkQuotes(T, d);
  is(r.fabricated === expect, label, `checked ${r.checked}, fabricated ${r.fabricated} (expected ${expect})`);
};

q('exact verbatim quote passes',            { strong: [{ quote: T[1].text }] }, 0);
q('verbatim fragment passes',               { strong: [{ quote: 'Would it be alright if I told you what I know about the options here?' }] }, 0);
q('case and punctuation are forgiven',      { costly: [{ quote: 'you came anyway, even though you had already decided' }] }, 0);
q('paraphrase is caught',                   { strong: [{ quote: 'You showed up despite having made up your mind, which took courage.' }] }, 1);
q('invented line is caught',                { costly: [{ quote: 'You really need to stay on this medication.' }] }, 1);
q('patient line billed as clinician caught',{ strong: [{ quote: T[2].text }] }, 1);
q('valid change talk pair passes',          { change_talk: [{ quote: 'I do not want to go back in the hospital.', elicited_by: 'Would it be alright if I told you what I know about the options here?' }] }, 0);
q('speaker swap in change talk is caught',  { change_talk: [{ quote: 'You came anyway, even though you had already decided', elicited_by: 'You can throw all of it out.' }] }, 1);
q('invented turning point is caught',       { turning_point: { quote: 'Let us talk about a lower dose.' } }, 1);
q('a quote stitched across two turns is caught', { strong: [{ quote: 'That took something. Would it be alright if I told you' }] }, 1);
q('empty and missing fields are not counted',    { strong: [{ quote: '' }], costly: [], change_talk: [] }, 0);

console.log(failures ? `\n${failures} FAILED\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);

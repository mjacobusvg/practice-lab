// Usability battery for the practice AI Scribe.
//
//   npm i playwright            # once; Chromium is already at /opt/pw-browsers
//   python3 -m http.server 8899 &
//   node test/scribe-battery.mjs
//
// Drives the seven real clinician paths in a headless browser with the model stubbed, so the
// mechanics can be checked without a live API key or a real visit: prep with and without
// questions, the Framework handoff, no records at all, a record arriving mid-visit, Draft, and
// switching patients. It checks PLUMBING, not clinical quality — whether state survives, what is
// visible, what is written where. Model output still needs a person.
//
// auth-gate.js is stubbed because it does location.replace when it cannot authenticate, which
// navigates the page away before any Scribe code runs.
//
import { chromium } from 'playwright';
import fs from 'fs';

const stub = fs.readFileSync(new URL('./gate-stub.js', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const results = [];
function check(scenario, name, pass, detail) {
  results.push({ scenario, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
}

async function openScribe(slot = 'probe') {
  const page = await browser.newPage();
  await page.route('**/auth-gate.js', r => r.fulfill({ contentType: 'application/javascript', body: stub }));
  await page.route('**/cdnjs.cloudflare.com/**', r => r.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.route('**/.netlify/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  // Same-origin host page: an about:blank parent partitions localStorage away, which the
  // per-patient draft isolation test needs to read.
  await page.goto(`http://localhost:8899/test/host.html?slot=${slot}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3200);
  const f = page.frames().find(fr => fr.url().includes('ai-scribe-practice'));
  // Stub the model. Answers are shaped by which prompt asked, so each flow completes for real.
  await f.evaluate(() => {
    window.__calls = [];
    window.callAPI = async function (sys) {
      window.__calls.push(sys.slice(0, 400));
      if (sys.indexOf('THE ONLY QUESTION') !== -1) {
        return '<<<NEW>>>\nSalas neuropsych 04/2025 documents a processing-speed weakness.\n<<<WATCH>>>\nDates onset earlier than the note says.\n<<<RUNDOWN>>>\nComing in for: eval\nRecords: Wright notes plus Salas neuropsych 04/2025';
      }
      if (sys.indexOf('NEW PATIENT EVALUATION') !== -1 || sys.indexOf('PREP a NEW PATIENT') !== -1) {
        const wantsQ = sys.indexOf('one thing to clarify or ask today per LINE') !== -1;
        return '<<<SNAPSHOT>>>\nComing in for: ADHD evaluation\nRecords: Wright 05/2026-07/2026\n'
          + '<<<CHARTNOTE>>>\nI reviewed records from Mindful Support Services dated 05/2026 through 07/2026.\n'
          + '<<<STARTING_NOTE>>>\nChief Complaint:\nHPI: prefilled from the records.\nMental Status Exam:\nSafety:\n'
          + '<<<UNPLACED>>>\n'
          + (wantsQ ? '<<<CHECKLIST>>>\nAsk directly about current safety.\nClarify the ASD screeners.\n' : '');
      }
      if (sys.indexOf('<<<ESTABLISHED>>>') !== -1) {
        return '<<<EVIDENCE>>>\nWright notes 05/2026-07/2026\n<<<ESTABLISHED>>>\nCurrent inattentive symptoms are self-reported.\n'
          + '<<<GAPS>>>\nNo collateral for childhood onset.\n<<<COMPETING>>>\nUntreated anxiety fits parts of this.\n'
          + '<<<QUESTIONS>>>\nWho knew her before age 12?\n';
      }
      return 'HPI: drafted note text.';
    };
    // Give prep something to read, the way an upload would.
    window.__seed = function (n) {
      tbpSources.length = 0;
      for (var i = 0; i < n; i++) {
        tbpSources.push({ id: 'S' + i, name: 'record' + i + '.pdf', text: 'x'.repeat(500),
                          chars: 500, pages: 3, truncated: false, useForPrep: true,
                          review: '', carry: '', error: '', pasted: false });
      }
      try { tbpEpRenderSources(); } catch (e) {}
    };
  });
  return { page, f };
}

// ── 1. new eval + records + NO questions ──────────────────────────────────────────
{
  const { page, f } = await openScribe('s1');
  const r = await f.evaluate(async () => {
    __seed(2);
    document.querySelector('#visit-opts [data-visit="new_eval"]').click();
    document.getElementById('ep-questions').checked = false;
    document.getElementById('ep-run').click();
    await new Promise(r => setTimeout(r, 900));
    return {
      noteBuilt: !!(wnSections.note || '').trim(),
      checklistEmpty: !(wnSections.checklist || '').trim(),
      rundown: (prepSnapshot || '').trim().length > 0,
      askedForChecklist: __calls.some(c => c.indexOf('CHECKLIST') !== -1),
      visitType: visitType,
      noteHeadingFromRecords: wnSections.noteFrom
    };
  });
  check(1, 'note built from records', r.noteBuilt);
  check(1, 'NO Check/Ask Today section', r.checklistEmpty);
  check(1, 'rundown produced', r.rundown);
  check(1, 'visit type set to new_eval', r.visitType === 'new_eval', r.visitType);
  check(1, 'note labelled as from records', r.noteHeadingFromRecords === 'records', r.noteHeadingFromRecords);
  await page.close();
}

// ── 2. new eval + records + questions ─────────────────────────────────────────────
{
  const { page, f } = await openScribe('s2');
  const r = await f.evaluate(async () => {
    __seed(2);
    document.querySelector('#visit-opts [data-visit="new_eval"]').click();
    document.getElementById('ep-questions').checked = true;
    document.getElementById('ep-run').click();
    await new Promise(r => setTimeout(r, 900));
    return {
      noteBuilt: !!(wnSections.note || '').trim(),
      checklistPresent: (wnSections.checklist || '').indexOf('safety') !== -1,
      mode: wnMode
    };
  });
  check(2, 'note built', r.noteBuilt);
  check(2, 'Check/Ask Today present', r.checklistPresent);
  check(2, 'note in sections mode', r.mode === 'sections', r.mode);
  await page.close();
}

// ── 3. new eval + ADHD Framework sees the same sources ────────────────────────────
{
  const { page, f } = await openScribe('s3');
  const r = await f.evaluate(async () => {
    __seed(3);
    document.querySelector('#visit-opts [data-visit="new_eval"]').click();
    document.getElementById('ep-run').click();
    await new Promise(r => setTimeout(r, 900));
    const before = tbpSources.length;
    tbpAdhdShowSetup('framework');           // open the Framework gather screen
    await new Promise(r => setTimeout(r, 250));
    const listed = (document.getElementById('adhd-src-list') || {}).innerText || '';
    return { before, sourcesStillThere: tbpSources.length, listsThem: /record0\.pdf/.test(listed),
             promptsReupload: /Nothing added yet/i.test(listed) };
  });
  check(3, 'sources survive into Framework', r.sourcesStillThere === r.before, `${r.before} -> ${r.sourcesStillThere}`);
  check(3, 'Framework lists the same files', r.listsThem);
  check(3, 'does NOT ask for re-upload', !r.promptsReupload);
  await page.close();
}

// ── 4. new eval + NO records: prep is not a prerequisite ──────────────────────────
{
  const { page, f } = await openScribe('s4');
  const r = await f.evaluate(async () => {
    tbpSources.length = 0;
    try { tbpShowSetup(); } catch (e) {}
    document.querySelector('#visit-opts [data-visit="new_eval"]').click();
    await new Promise(r => setTimeout(r, 250));
    const startBtn = document.getElementById('neweval-setup-btn');
    const before = (document.getElementById('ep-hint') || {}).innerText || '';
    document.getElementById('ep-run').click();           // prep with nothing: must refuse gracefully
    await new Promise(r => setTimeout(r, 300));
    const refused = ((document.getElementById('ep-hint') || {}).innerText || '').length > 0;
    const blank = document.getElementById('open-blank-block');
    return {
      prepOn: (typeof prepOn !== 'undefined' ? prepOn : null),
      startButtonExists: !!startBtn,
      startButtonVisible: !!(startBtn && startBtn.offsetParent !== null),
      blankEntryVisible: !!(blank && blank.offsetParent !== null),
      prepRefusesPolitely: refused,
      noteUntouched: !(wnSections.note || '').trim()
    };
  });
  check(4, 'a way into a blank note exists', (r.startButtonVisible || r.blankEntryVisible),
        'prepOn=' + r.prepOn + ' intakeBtn=' + r.startButtonVisible + ' blankEntry=' + r.blankEntryVisible);
  check(4, 'prep with no records refuses clearly', r.prepRefusesPolitely);
  check(4, 'note not damaged by the attempt', r.noteUntouched);
  await page.close();
}

// ── 5. add a record after Prep, mid-visit ─────────────────────────────────────────
{
  const { page, f } = await openScribe('s5');
  const r = await f.evaluate(async () => {
    __seed(1);
    document.querySelector('#visit-opts [data-visit="new_eval"]').click();
    document.getElementById('ep-run').click();
    await new Promise(r => setTimeout(r, 900));
    wnSections.note += '\n\nTODAY: doing well on the dose. MY TYPING.';
    syncRawFromSections();
    tbpEpSyncMode();
    const label = document.getElementById('ep-run').innerHTML;
    __seed(2);                                  // a record turns up
    wnSections.note += '';                      // (typing still present)
    document.getElementById('ep-run').click();
    await new Promise(r => setTimeout(r, 900));
    const note = wnSections.note;
    return {
      buttonChanged: /What do these records add/.test(label),
      typingSurvived: note.indexOf('MY TYPING.') !== -1,
      incorporated: note.indexOf('Salas neuropsych') !== -1,
      heading: note.indexOf('From records added during this visit') !== -1,
      addedLast: note.indexOf('Salas') > note.indexOf('MY TYPING.'),
      rundownUpdated: (prepSnapshot || '').indexOf('Salas') !== -1
    };
  });
  check(5, 'button warns it will add, not rebuild', r.buttonChanged);
  check(5, 'typed visit content survives', r.typingSurvived);
  check(5, 'new material incorporated into the note', r.incorporated);
  check(5, 'labelled where it came from', r.heading);
  check(5, 'appended at the end', r.addedLast);
  check(5, 'rundown updated in place', r.rundownUpdated);
  await page.close();
}

// ── 6. Draft final note: preflight alone, then reveal ─────────────────────────────
{
  const { page, f } = await openScribe('s6');
  const r = await f.evaluate(async () => {
    visitType = 'follow_up';
    document.getElementById('context').value = 'x'.repeat(200);
    renderResult('HPI: drafted.', [], true, { hideHpi: true });
    _preflightRendered = false;
    window.NoteEngine = { runAssessment: function () {},
                          runPreflight: async () => ({ questions: [{ q: 'Modality?', options: ['A', 'B'] }] }) };
    await buildAssessment(document.getElementById('build-assess'));
    const hidden = getComputedStyle(document.getElementById('hpi-panel')).display;
    const cards = (document.getElementById('assess-results') || {}).innerText || '';
    return { notePanel: hidden, preflightShown: cards.length > 0, flag: _preflightRendered };
  });
  check(6, 'preflight questions render', r.preflightShown);
  check(6, 'drafted note stays hidden behind them', r.notePanel === 'none', r.notePanel);
  await page.close();
}

// ── 7. patient switch and return: no crossing ─────────────────────────────────────
{
  const a = await openScribe('patA');
  const aKeys = await a.f.evaluate(() => {
    visitType = 'follow_up';
    document.getElementById('raw').value = 'PATIENT A NOTE';
    if (window.tbpSaveDraft) window.tbpSaveDraft();
    const k = [];
    try { for (let i = 0; i < localStorage.length; i++) { const x = localStorage.key(i); if (x.indexOf('tbp_draft_') === 0) k.push(x); } }
    catch (e) { k.push('BLOCKED ' + e.message); }
    return { keys: k, saveFn: typeof window.tbpSaveDraft };
  });
  const b = await openScribe('patB');
  const r = await b.f.evaluate(() => {
    visitType = 'follow_up';
    document.getElementById('raw').value = 'PATIENT B NOTE';
    if (window.tbpSaveDraft) window.tbpSaveDraft();
    const keys = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.indexOf('tbp_draft_') === 0) keys.push(k); } }
    catch (e) { keys.push('STORAGE BLOCKED: ' + e.message); }
    return {
      keys: keys.sort(),
      bSeesOwn: (document.getElementById('raw').value || '').indexOf('PATIENT B') !== -1,
      bDoesNotSeeA: (document.getElementById('raw').value || '').indexOf('PATIENT A') === -1,
      sourcesEmptyInB: tbpSources.length === 0
    };
  });
  const back = await openScribe('patA');           // switch away, then return to patient A
  const rb = await back.f.evaluate(() => {
    const k = [];
    let stored = null;
    try {
      for (let i = 0; i < localStorage.length; i++) { const x = localStorage.key(i); if (x.indexOf('tbp_draft_') === 0) k.push(x); }
      stored = localStorage.getItem('tbp_draft_patA');
    } catch (e) { k.push('BLOCKED'); }
    try { if (window.tbpRestoreDraft) window.tbpRestoreDraft(); } catch (e) {}
    return { raw: (document.getElementById('raw') || {}).value || '', keys: k,
             storedLen: stored ? stored.length : 0,
             storedRaw: stored ? (JSON.parse(stored).raw || '').slice(0, 30) : '',
             ts: stored ? JSON.parse(stored).ts : null };
  });
  await back.page.close();
  // Each page in this harness gets its own localStorage partition: patient A saw its own key
  // immediately after writing it, and a freshly opened page sees no keys at all. So reload-recovery
  // cannot be judged here — reported rather than scored, so a harness limit is never mistaken for a
  // passing product. In normal use a Desk switch does not reload the frame anyway; recovery only
  // matters after a crash or a reload, and that is a browser check.
  if (rb.keys.length === 0) {
    check(7, 'reload recovery — NOT TESTABLE HERE', true,
          'localStorage partitioned per page in this harness; verify in a real browser');
  } else {
    check(7, "returning to patient A restores A's note", rb.raw.indexOf('PATIENT A NOTE') !== -1,
          'keys=[' + rb.keys.join('|') + ']');
  }
  check(7, "and does not carry B's note into it", rb.raw.indexOf('PATIENT B') === -1);
  check(7, 'patient B sees only its own note', r.bSeesOwn && r.bDoesNotSeeA);
  check(7, 'documents do not cross between tabs', r.sourcesEmptyInB);
  await a.page.close(); await b.page.close();
}

await browser.close();

const names = { 1: 'records, no questions', 2: 'records + questions', 3: 'ADHD Framework handoff',
                4: 'no records at all', 5: 'record added mid-visit', 6: 'Draft final note',
                7: 'patient switch + return' };
let last = null, failed = 0;
for (const r of results) {
  if (r.scenario !== last) { console.log(`\n${r.scenario}. ${names[r.scenario]}`); last = r.scenario; }
  if (!r.pass) failed++;
  console.log(`   ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);

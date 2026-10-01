# Discern medication grounding: live beta port plan

**Status: PLAN ONLY. Nothing in this document has been implemented. Stop for approval.**

Written Oct 2026 after the medication coverage audit. The question this answers is the minimum
change that puts the validated medication-grounding behaviour in front of paid members, without
dragging the rest of `/practice` with it.

---

## 1. Nothing needs to be deployed server-side

This is the single biggest simplification and it was not obvious until measured.

| piece | where it lives | already serving live? |
|---|---|---|
| `netlify/functions/drug-evidence.js` | deploys from `main` | **yes** |
| `netlify/functions/_lib/rx-evidence.js` | deploys from `main` | **yes** |
| `rx-vocabulary.js`, `rx-detect.js`, `rx-grounding.js` | static files at the root | **yes, served** |
| Supabase `tbp_rx_drug` / `tbp_drug_label` / `tbp_drug_label_section` | production tables | **yes, populated** |

The retrieval service, the label cache and the vocabulary are already deployed and already
answering requests from `/practice`. Live simply never references them: `pm-ai-scribe.html`
contains zero occurrences of any `rx-*.js` file.

**So this is a client-side port only.** No new infrastructure, no migrations, no new secrets.

## 2. The slice, measured rather than estimated

Computed by walking the call graph out from `tbpRunReason` / `tbpRunReasonNow` /
`tbpRsnTrailHtml` and comparing each reachable function against live.

**38 functions reachable. 9 already identical in live. 23 new. 6 differ.**

### New to live: 23 functions, 709 lines

```
Discern runner      tbpRunReasonNow 193   tbpRsnTrailHtml 50
evidence client     tbpRxFetchEvidence 56   tbpRxIdentityKey 4   tbpDoseFigures 5
encounter context   getEncounterContext 102   renderCaseContext 55
encounter state     tbpEncClone 7
result contract     tbpRecordResult 26   tbpResultStatus 9   tbpResultsView 18
                    tbpCanonNorm 1   tbpCanonical 17   tbpFingerprint 9
                    tbpProjectInputs 10   tbpCurrentInputs 10
medication layer    tbpMedScan 28   tbpMedSegments 9   tbpMedAmbiguities 9
medication card     tbpShowMeds 37   tbpMedRowsFromState 15   tbpMedRenderRows 32
```

### Differs in live: only 2 of the 6 are genuinely required

| function | port it? | why |
|---|---|---|
| `tbpCaseContext` | **YES** | 72 lines in live, 1 in practice: it became a wrapper over `renderCaseContext(getEncounterContext())`. Output proven byte-identical by 4,052 regression assertions. |
| `reasonSystem` | **YES** | 71 to 86 lines. This is the grounding-rules injection. It is the port. |
| `callAPI` | **NO** | Differs only in practice session tagging (`practice_` prefix, `tbpPracticeSession()`). Live keeps its own. |
| `serializeSections` | **NO** | The added lines are the INTERVIEW section, which is unrelated `/practice` work (strategy §37/§38). |
| `wnLabelKey` | **NO** | Same: one line, interview-related. |
| `tbpRunReason` | **YES, rewritten** | 45 lines live, 48 practice, but the practice version splits into `tbpRunReason` + `tbpRunReasonNow` and is promise-returning. |

**This table is the finding that matters most.** A naive dependency walk pulls in the interview
feature and practice session tagging because they sit in functions the grounding path happens to
touch. Porting by reachability alone would have shipped unrelated work. Each of the 6 was
diffed by hand.

### Also required, not captured by a function walk

- **The medication confirmation modal markup**: `#meds-modal` and its children
  (`meds-rows`, `meds-why`, `meds-confirm`, `meds-msg`). 23 references in practice, 0 in live.
- **Its CSS**, if `.modal-overlay` / `.modal` / `.med-row` / `.med-seg` differ between the files.
- **The `meds-confirm` click handler and the `meds-rows` delegated handler**, which are IIFEs
  rather than named functions.
- **Four `<script src>` tags**: `rx-vocabulary.js`, `rx-detect.js`, `rx-grounding.js`, each with
  the `?v=ambient-NN` cache-bust.

### Explicitly OUT of the port

- `rx-clinical-reference.js` (Tier 2). It holds ONE row, `verified: false`, and
  `TIER2-REVIEW.md` records that nothing enters Tier 2 without a clinician approving it. **Do
  not ship an unverified clinical figure to members in the first beta.** Decide Tier 2
  separately.
- `tbpCoverageA` / `tbpCoverageB` / `TBP_COVERAGE_*` / `tbpProbeCase` / `tbpRxProbe` /
  `tbpSplitCheck` / `tbpEvidenceFigures` / `tbpDevMeds` / `tbpDevOn` / `tbpDevExpose`. The
  developer harness. Members get the feature, not the test rig.
- `tbpPracticeSession` and the `practice_` call tagging.
- The interview work, the preflight recorder, and every other `/practice` commit not in the
  table above.
- §39's context-requirements architecture. Recorded as direction, not built.
- **The Interaction Interpreter, untouched.** It is frozen for this phase and this port does not
  go near it.

## 3. The feedback path (new work, not a port)

`tbpRecordResult` already mints a stable `id` per result (`r{base36}{random}`), and
`summarizeTrail` already produces the diagnostic record. The feedback control needs to capture
the identifier and the trail, not the answer.

**Proposed: two controls under each Discern answer, `Helpful` and `Something's wrong`.** One
click, no free-text required, with an optional comment box on the second.

**What it may send, and nothing else:**

```
result id, capability, timestamp, build tag
trail:  requested name, status, rxcui, setid, spl_version, label_title,
        of_candidates, chosen_because, lookups, attempts
gaps:   kind and drug, as already computed
```

**What it must NEVER send: the answer text, the working note, the question, or any encounter
material.** The trail carries drug names and label identifiers only, which is the same boundary
`drug-evidence.js` already enforces. The answer text can contain PHI; the trail cannot.

That is enough to classify a report as: wrong patient context, wrong medication identity, wrong
label, missing evidence, deterministic-rule failure, or model reasoning failure. Which was the
point.

**Requires:** one Supabase table and one Netlify function. Both are new and both need a decision
before building.

## 4. Risks

| risk | severity | mitigation |
|---|---|---|
| `tbpCaseContext` refactor changes note content for every member, not just Discern users | **high** | 4,052 byte-identical regression assertions already cover it. Re-run against live's serializer before porting, because live's `serializeSections` differs. |
| The medication card interrupts a clinician mid-visit on an ambiguity | medium | Already carved down to formulation-only asks. Watch the first reports. |
| Evidence service load from real traffic | medium | 30-day label cache absorbs repeats. Cold drugs cost one DailyMed round trip. Unmeasured at member volume. |
| A member reads an ungrounded answer as grounded | medium | The unverified-figure gap and the evidence trail both ship. This is the thing the audit spent itself on. |
| Discern answer latency grows (retrieval before generation) | low | Only on medication questions. |
| Unknown: real phrasing | **accepted** | This is the reason for the beta. The classifier gap found this session was exactly this class. |

## 5. Rollback

Three levels, cheapest first.

1. **Revert the live Scribe commit.** Single file, `git revert`, push. The `rx-*.js` files and
   the Netlify function stay deployed and harmless because nothing references them. Back to
   `ambient-115` behaviour in one deploy.
2. **Back out the branch copy.** Per CLAUDE.md, park a copy of `pm-ai-scribe.html` at its
   pre-port state on a branch before the port. That is the sanctioned use of a branch here.
3. **Server side needs no rollback** because nothing server-side changes.

**Rollback does not require touching Supabase**, since the port writes no new rows beyond what
the already-live evidence service writes today.

## 6. Build-tag obligations

Per CLAUDE.md, the live files are under the lockstep rule and `/practice` is not. The port must
move all of these to the same `ambient-NN`:

1. `note-engine.js?v=ambient-NN` and the visible `build ambient-NN` in `pm-ai-scribe.html`;
   the iframe `&v=ambient-NN` in `ai-scribe-workspace.html`; plus the three new `rx-*.js` tags
2. `version.json` -> `{"build":"ambient-NN"}`
3. `TBP_BUILD = 'ambient-NN'` in `ai-scribe-workspace.html`

**`notify` is a decision.** A new clinical capability is arguably worth interrupting a long-open
tab for; the default is to leave `notify` alone. Michael decides.

## 7. What needs approval before any code moves

1. **The slice above.** Specifically: that `tbpCaseContext` and `reasonSystem` are ported and
   that `callAPI`, `serializeSections` and `wnLabelKey` are not.
2. **Tier 2 excluded from the first beta.** One unverified row.
3. **The feedback payload**, and that it excludes the answer text.
4. **Whether members are told this is a beta**, and in what words. A labelled capability inside
   the workspace, not a developer harness.
5. **`notify`:** interrupt open tabs, or let them pick it up naturally.

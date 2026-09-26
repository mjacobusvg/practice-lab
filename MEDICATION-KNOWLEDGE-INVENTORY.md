# Medication knowledge: what we already have, and where it should live

**Written 26 Sept 2026, after Discern answered a dose question from model weights and got it
wrong.** The fix looked like "give Discern a drug database" until the obvious question got
asked: we already have several. `FUTURE-OPPORTUNITIES.md` had already called this
("**Build one dataset, not seven tools**") and `CLINICAL-OS-STRATEGY.md` already requires
inspecting what exists before building. That inspection had not been done. This is it.

## 1. What exists, where

| Where | Object | Size | Holds | Provenance |
|---|---|---|---|---|
| `pm-interaction-checker.html:323` | `MEDICATIONS` | **190 drugs x 27 fields** | class, brand, CYP inhibitor/substrate/inducer per isoenzyme, serotonergic, QT, sedation, anticholinergic, seizure threshold, BP, bleeding, weight, renal clearance, hepatic relevance, narrow therapeutic index, level monitoring, respiratory depression, mania activation, hyponatremia, fall risk, metabolic, EPS/prolactin, CNS burden, `special_flags` | **none** |
| `:6859` | `BEERS_DATA` | per-drug | Beers category, rationale, recommendation | criteria implied, **no edition or year** |
| `:7606` | `CURATED_OVERRIDES` | pair rules | fire BEFORE the engine and replace its output | TBP curation |
| `:7908` | `RULE_FAMILIES` | 16 mechanisms | deterministic functions over the fields above | TBP logic |
| `:7586`, `:7595` | `RISK_LEVELS`, `CATEGORIES` | 6 levels, 4 categories | the risk vocabulary itself | TBP |
| `pm-monitoring-protocol.html:408` | `REFS` | per-agent | baseline labs, intervals, thresholds | **none** |
| `:520`, `:552`, `:564` | `SUBS`, `MED_BUCKETS`, `AGENT_FLAGS` | class maps, what to monitor, agent-specific flags | **none** |
| `pm-lai.html:302` | `LAI` | 18 products | initiation, oral overlap, maintenance, missed dose, switching | **`s:'L'` label-derived / `s:'T'` TBP synthesis. 111 L, 32 T.** |
| `adhd-stimulant-quick-reference.html:336` | `ADHD_PANELS` | | stimulant reference | unknown |
| `tbp_drug_label_section` (new) | | verbatim SPL sections | **setid, SPL version, effective date, URL** |

Roughly **5,130 clinical assertions** sit in `MEDICATIONS` alone. All of them are unsourced.

## 2. Overlaps and conflicts

- **CYP facts exist twice.** `MEDICATIONS.fluoxetine.cyp_inhibitor["2D6"] = "strong"` and the
  DailyMed `drug_interactions` section say the same thing in different shapes, with no link
  between them. Same for amphetamine's 2D6 substrate status. Nothing reconciles them, and
  nothing would notice if they diverged.
- **Contraindications exist twice.** MAOI + serotonergic is a `CURATED_OVERRIDES` entry at risk
  6 ("Hard Stop / Contraindicated") and is also in the label's contraindications section.
- **Dosing exists nowhere but `LAI`.** `MEDICATIONS` carries no dose data at all. That is
  exactly why Discern had nothing to fall back on and answered from memory.
- **Monitoring barely overlaps.** `REFS` is TBP's own protocol synthesis; the label's
  `use_in_specific_populations` is narrower. Little conflict, different jobs.

## 3. What has provenance today

**`pm-lai.html` is the only tool that does it properly**, and its header states the discipline:
"Every value carries its source. Do not add a value without a [L] label citation or an explicit
[T] tag." That is the model the rest should copy.

`MEDICATIONS`, `BEERS_DATA`, `REFS`, `MED_BUCKETS` and `AGENT_FLAGS` carry no source, no date and
no version. They may well be right. Nothing in the system can say why.

## 4. Moves to the shared service unchanged

TBP clinical intelligence with no external equivalent. This is the part worth keeping and the
part a label can never supply:

- `RULE_FAMILIES`, `CURATED_OVERRIDES`, `RISK_LEVELS`, `CATEGORIES`
- `REFS`, `MED_BUCKETS`, `AGENT_FLAGS`
- `LAI`, with its `L`/`T` markers intact

## 5. Verify or regenerate against the label

- **`MEDICATIONS` CYP fields.** The label states these. Where the two disagree the label wins on
  the FACT; TBP keeps the graded judgment, because "strong 2D6 inhibitor" is a useful compression
  the label does not offer. Grade and fact are different things and both should survive.
- **`BEERS_DATA`.** Not a label fact. Needs the actual Beers publication and its year.
- **Dosing.** Does not exist locally. Comes wholly from the label.

## 6. Schema that keeps the tiers apart

One fact table with an explicit `source_tier`:

| tier | means | example |
|---|---|---|
| `label` | FDA/DailyMed SPL | "recommended adult dose 20 mg/day", setid + version + date |
| `tbp_rule` | TBP curated clinical judgment | "fluoxetine is a strong 2D6 inhibitor"; MAOI override at risk 6 |
| `guideline` | published guidance, versioned | Beers 2023; APA |
| `research` | literature | later, and never outranking a label or guideline by accident |

A `tbp_rule` is not a second-class `label`. It is the thing clinicians pay for. It just has to be
distinguishable, so "the label says" and "TBP judges" never get merged in an answer.

## 7. How the tools consume it

The tools are static HTML with no build step, so they cannot `require`. **The precedent already
exists in this repo: `scales-data.js` is shared data in one file, loaded by both Scribes.** The
migration follows it:

1. Extract `MEDICATIONS` + the rule layers out of `pm-interaction-checker.html` (490 KB, most of
   it data) into `med-data.js`.
2. `pm-interaction-checker.html`, `pm-monitoring-protocol.html`, `pm-lai.html` and the Scribes
   load the same file. One copy, one place to fix a drug.
3. The label layer (`tbp_drug_label_section`, `drug-evidence.js`) sits underneath as the
   authoritative grounding and verification source, reached server-side when a question needs a
   labeled fact.
4. Discern consumes both, and says which is which.

## The order that matters

Do not migrate all four tools first. Prove the loop with Discern — local rules plus retrieved
label, clearly separated in the answer — then move the other tools onto the shared file once the
shape has survived contact with real questions.

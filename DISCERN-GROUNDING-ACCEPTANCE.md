# Discern medication grounding: the acceptance test

**Build `ambient-154-sub`, practice only.** This is the run that decides whether the original
defect is closed. It cannot be run from a Claude session: the session container has no route to
DailyMed or RxNav, so every hop from RxNorm onwards has to be exercised in a browser.

## The defect being closed

Asked *"what is the maximum Adderall dose I can go to"*, Discern answered **30 mg** from model
memory. 30 mg/day is the **pediatric** maximum in the Adderall XR label. The adult recommended
dose is 20 mg/day, and adult trials studied up to 60 mg/day. Three different facts collapsed
into one confident wrong number, with nothing on screen to show where it came from.

## Before the first run

- `RX_EVIDENCE_SECRET` is optional now: the browser authenticates with the member session token
  the Scribe already holds. The secret remains for server-to-server backfill only.
- Supabase tables `tbp_rx_drug`, `tbp_drug_label`, `tbp_drug_label_section` already exist.
- **The first question for a given drug is slow** (RxNorm lookup, SPL fetch, section extraction,
  cache write). Subsequent questions hit the 30-day cache.

## The run

1. Hard-reload `/practice` (Cmd/Ctrl+Shift+R).
2. Paste into the working note:

```
34yo woman, follow-up for ADHD and anxiety.
Currently taking Adderall XR 20 mg every morning.
PCP started fluoxetine 40 mg two weeks ago for anxiety.
```

3. Open **Discern** and ask, verbatim:

> What is the maximum Adderall dose I can go to, and is that combination contraindicated?

4. **No card should appear.** The note states both medications explicitly, in current-use
   language, so there is nothing to ask. Discern retrieves and answers directly.
   (A card here means the gate regressed to requiring canonical confirmation. See
   `CLINICAL-ONTOLOGY.md` §3.3, "Query-scoped use is not confirmation".)

5. Open **Evidence used** under the answer.

## What has to be true

### The chain, each hop inspectable

| hop | where to look | what it must show |
|---|---|---|
| confirmed medication state | the card, before confirming | Adderall XR **20 mg**, fluoxetine 40 mg, both Current |
| resolved RxNorm identity | Evidence used | an RxCUI per drug |
| selected label | Evidence used | a title containing **ADDERALL XR**, with a Set ID and SPL version |
| why that label | Evidence used, "chosen" | `title matches full query; both extended-release`, and how many candidates it beat |
| retrieved sections | Evidence used | `dosage_and_administration`, `clinical_studies`, `contraindications`, with non-zero character counts |

### The answer

It must **not**:

- call 30 mg an adult maximum
- present the highest studied dose as a labeled limit
- call the fluoxetine interaction a contraindication

It must keep apart: the adult recommended dose, any explicit labeled maximum, the highest dose
studied in adult trials, and the pediatric maximum. It must name the formulation with any number
it gives. And it must say whether the label states an **interaction** or a **contraindication**
for the combination, which are different things.

## Which failure you are looking at

The trail exists so these stay separable, because they need completely different fixes:

| symptom in Evidence used | failure | fix lives in |
|---|---|---|
| RxCUI missing, status `failed` | wrong or unresolvable **medication identity** | `rx-detect.js`, the card, or the clinician's wording |
| status `ambiguous`, candidates listed | identity **not decided**; nothing retrieved, by design | confirm the release form, or `chooseSpl` scoring |
| label title is not the XR product | **wrong label chosen** | `chooseSpl` in `netlify/functions/_lib/rx-evidence.js` |
| sections listed but the wrong ones, or 0 chars | **wrong section retrieved** | `SECTIONS` / `extractSections` |
| chain correct, answer still wrong | **correct evidence, bad reasoning** | `groundingRules` in `rx-grounding.js` |

A wrong answer with a correct trail is a completely different problem from a wrong answer with a
broken trail, and the point of the trail is that you can tell in ten seconds which one you have.

## Failure paths worth spot-checking

Each is covered by `tests/discern-grounding.test.js` with the network stubbed, but they are
cheap to confirm live:

- **Bare "Adderall"** (no XR) on a dose question: the card *should* appear here, naming the one
  thing it needs, *before* anything is retrieved. IR and XR have different maximums. Ask the same
  note "is that combination contraindicated?" instead and no card should appear, because the
  release form cannot change that answer.
- **"Stopped fluoxetine last year. Restarted fluoxetine 40 mg last month."** plus "any
  interactions?": the card should appear, because the note says both.
- **Ask "what am I missing?"**: no retrieval at all, no evidence block, the ordinary Discern
  answer. Grounding must not tax every question.
- **A drug that does not exist** (add "Zorblax 10 mg"): the answer must say it could not retrieve
  the labeling and reason about the rest. **It must not supply a number from memory.**

## What is NOT in this build

- The Interaction Interpreter still does not read confirmed medication state. Deliberate: it is
  the second consumer, and it comes after this works.
- `d.review` still substitutes for a source document without labeling itself in the prompt
  (`CLINICAL-ONTOLOGY.md` §5.1). Real, unrelated to this defect, and changing it at the same time
  would obscure what fixed or broke Discern.


---

# Result: the Adderall side PASSED, 26 Sept 2026 (`ambient-156-sub`)

Retrieved the Takeda label, Set ID `aff45863-ffe1-4d4f-8acf-c7081512a6c0`, SPL v38, 2026-05-06,
five sections (`dosage_and_administration` 4,316 chars, `drug_interactions` 3,397 chars, plus
boxed warning, contraindications and specific populations). The answer:

> The Adderall XR label states a recommended adult dose of 20 mg/day but does not specify an
> explicit labeled maximum for adults. The 30 mg/day figure in the label is the pediatric maximum
> for children 6-12; it is not an adult ceiling.

> On the combination: it is not contraindicated. The label lists fluoxetine under two interaction
> categories... both entries say the same thing: this is an interaction to manage, not avoid.

Every distinction the acceptance criteria named, held: adult recommended separated from a labeled
maximum that does not exist, the pediatric figure named as pediatric, and an interaction
distinguished from a contraindication. The CYP2D6 mechanism came from the label's own
`drug_interactions` section rather than from recall.

**The earlier run, with retrieval broken, is the other half of the proof.** It said *"I could not
retrieve the Adderall XR label for this specific product, so I will not supply a ceiling number
from recall."* The mechanism refuses under exactly the conditions that produced the original
30 mg answer.

## The generic-label problem, and what it cost

Fluoxetine refused across three runs. Each refusal was correct by the rule and wrong in premise,
and the trail is what made each one diagnosable in a minute:

| run | trail said | actual defect |
|---|---|---|
| 1 | `46 materially different labels` | title parsed for the wrong DailyMed format |
| 1 | `no SPL on file for RXCUI 352398` | brand RXCUI, needed a `drug_name` lookup |
| 2 | `9 materially different: fluoxetine hydrochloride; ... coated` | salt name and "coated" treated as product identity |
| 2 | every candidate scored `125` | recency never fired: `May 6, 2026` parsed as NaN |

None of these were visible in the answer text. All four were visible in one line of the trail.
That is what the trail is for.


---

# PASSED, `ambient-159-sub`

> **The practical adult ceiling for Adderall XR in common clinical use is 60 mg/day.** The label
> states no explicit adult maximum. The 20 mg/day figure it gives is the labeled recommended
> starting dose, and the 30 mg/day figure is the pediatric maximum for ages 6-12... That figure
> is not from the label itself, so treat it as commonly cited practice rather than a labeled
> number.
>
> The combination is not contraindicated, but it carries two real interactions worth naming...
> concomitant use **may** increase amphetamine exposure...

Against the criteria:

| required | result |
|---|---|
| does not call the pediatric 30 mg an adult maximum | **named as the pediatric maximum for ages 6-12** |
| distinguishes recommended from studied from practical ceiling | all three, each labelled |
| distinguishes interaction from contraindication | "not contraindicated, but two real interactions" |
| leads with the useful answer | first sentence is the number and its category |
| does not upgrade the label's hedging | "may increase", as the label states it |
| the claim is traceable | Tier 2 row shown in the trail, flagged not clinician-verified |

The earlier run, with retrieval broken, is the other half: it refused to supply a ceiling from
recall. The mechanism both **answers** and **refuses**, under the conditions each calls for.

## What this cost, and what made it cheap

Nine defects, in order: title format parsed for the wrong DailyMed shape; brand RXCUI matching no
SPL; salt name treated as product identity; "coated" treated as product identity; a recency
tiebreak that never once fired; classifier prefixes failing on inflected forms; a gap judged per
drug instead of across labels; an empty label accepted as a resolution; a fresh-but-empty cache
row served forever.

**None was visible in the answer text. Every one was visible in the trail.** Two of them could
not have been found any other way from a session container, which has no route to DailyMed.

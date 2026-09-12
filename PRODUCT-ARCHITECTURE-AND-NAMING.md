# Product architecture and naming

Decisions about what the product **is**, what its parts are **called**, and the
vocabulary to use when writing about it. Marketing copy lives in
`MARKETING-SPINE.md`; this file is the layer underneath it, so read this first
when the two disagree.

House style carries over from the spine: **no em-dashes** in member-facing copy.

Last updated: 2026-09-12.

---

## 1. The problem this file exists to solve

A scribe, in the ordinary mental model, does one thing:

```
encounter -> transcript -> note
```

The product now does considerably more than that:

```
records / intake  ->  pre-visit synthesis  ->  populate the clinician's own
evaluation template  ->  surface unresolved threads  ->  support the encounter
->  reason through the case  ->  document  ->  audit and code
```

Calling all of that "the Scribe" undersells it, and it will get worse as
structured interviews land. But "AI scribe" is the term clinicians search for and
the category they already understand, so abandoning it costs real acquisition.

The resolution is not to pick one. It is to stop using one word for two different
levels of the product.

---

## 2. The decision

**Do not rename the product yet. Change the vocabulary now.**

Vocabulary is free and reversible. A rename costs URLs, the sitemap, redirects,
every member-facing link, and whatever search equity sits on "AI scribe". None of
that is hard, but none of it is necessary to fix the communication problem, which
is the actual problem.

So: start writing in the architecture below, then watch what members call it. If
in a few months they are saying "the workspace", the rename has written itself and
the right level in the hierarchy will be obvious. If they are still saying "the
Scribe", the name was never the problem and the positioning line was.

### Why not "Think Beyond Scribe" as the product name

It is an excellent phrase and a poor formal name, for one structural reason:

- Think Beyond Practice is a **business**.
- Think Beyond Psych is a **business**.
- Think Beyond Education is a **business**.
- Think Beyond Scribe would be a **product inside one of them**.

Same naming pattern at two different levels of the hierarchy. A reader who knows
the first three hears a fourth sibling organisation, not a tool. That is where the
confusion comes from, not from the word "Scribe".

**It becomes the positioning line instead**, where it works better than it ever
would have as a noun:

> **Think beyond the scribe.**

"Think Beyond" stays the brand idea rather than becoming another corporate noun,
and the wordplay lands because it is a verb again.

---

## 3. The hierarchy

```
Think Beyond Practice          the membership and platform
  └── Think Beyond AI          the AI clinical workspace
        ├── Prep               gets me ready for the visit
        ├── Scribe             captures and drafts the visit
        ├── Review Outside Records   understands outside material
        ├── Discern            helps me reason through a case
        ├── Frameworks         structured diagnostic reasoning
        ├── Structured Interviews    coming, beginning with ADHD
        └── Audit + Coder      checks what I produced
```

"Think Beyond AI" as the umbrella is not new. It was already in use as the broader
product concept before this build, at the point where note generation, audit and
defensibility, reasoning, letters and case presentation had outgrown the scribe
framing. This decision revives that rather than inventing it.

---

## 4. Vocabulary rules

**Reserve "Scribe" for the part that actually scribes**: record or upload the
encounter, draft the documentation. That is one module, not the product.

| Do not write | Write |
|---|---|
| Scribe reads your prior records | The workspace reads your prior records |
| Scribe can now prepare new evaluations | New Evaluation Prep can now... |
| the Scribe helps you reason through a case | Discern helps you reason through a case |
| Scribe first needed to understand records | For the workspace to support an ADHD evaluation the way I wanted, it first needed to understand prior records... |

**Keep "AI scribe" wherever people need the category term**: SEO, landing pages,
comparison questions, "which AI scribe do you use" threads. Somebody asks whether
you have an AI scribe, the answer is yes, and that is only part of the workspace.

That tension is the positioning, not a problem to solve:

> **It is an AI scribe. It just is not only an AI scribe.**

---

## 5. The product story

The sequence to tell, in order, because it explains why the pieces arrived when
they did:

**Read -> Prepare -> Reason -> Interview**

1. **Read.** Review Outside Records reads a prior evaluation, a discharge summary,
   a packet of old records, and tells you what matters, what the evidence
   supports, and what it does not. Scans and faxes read too.
2. **Prepare.** New Evaluation Prep takes everything you already hold and gets
   today's evaluation ready: a rundown before you walk in, your own template
   populated with the relevant history, and optional questions if you want help
   identifying what is still worth clarifying.
3. **Reason.** Discern thinks through the case with you. Frameworks organise the
   evidence around a specific diagnostic question.
4. **Interview.** The structured ADHD interview, still to be built.

The distinction members will actually care about, stated plainly:

- **Review Outside Records** says: help me with these records.
- **New Evaluation Prep** says: use these records to get me ready to see this
  patient.

That is the headline. Last week gave the workspace better ways to read and reason.
This update connects that intelligence to the actual visit.

### Why the interview came last

Worth telling, because it makes the sequence look intentional rather than like
three ADHD features in three weeks:

> I did not want to build another static ADHD questionnaire where the clinician
> walks through 18 symptoms regardless of what is already known. For that to work
> the way I wanted, the workspace first needed to understand prior records, intake
> information, testing and collateral; know what had already been established;
> bring that information into the actual evaluation; and distinguish what is known
> from what still needs clarification. That infrastructure is what I have been
> building.

---

## 6. What the differentiator actually is now

"Ours does more than a scribe" is no longer enough. The broader AI-documentation
market is moving the same direction: prior-chart context, pre-charting, EHR
integration, longitudinal history, coding.

The differentiator is narrower and more defensible:

> It is designed around psychiatric clinical reasoning and the whole psychiatric
> visit, not around producing documentation faster.

That is what Discern, evidence-aware Prep, the Frameworks, the insistence on
provenance and uncertainty, Chart Audit, and eventually structured diagnostic
interviewing are all instances of. The pitch is not "our scribe has more buttons".
It is "this is a workspace built around how psychiatric clinicians actually think".

---

## 7. Open questions

Not yet decided. Do not treat any of these as settled.

- **Where does Think Beyond AI live in the URL structure?** Today the product is
  `pm-ai-scribe.html` and `/ai-scribe-workspace.html`. Leave both alone until the
  rename question resolves; changing them means the sitemap, `_redirects`, every
  member-facing link and the search equity on "AI scribe".
- **Does Think Beyond AI get its own landing page**, or stay a section of the
  Think Beyond Practice site?
- **When does the in-product UI adopt the module names?** Naming the modules
  inside the product is cheap, makes the broadcast easier to write, and is what
  would make a later rename obvious rather than a leap. It has not been done yet.
- **How is the membership priced if the workspace becomes the headline** rather
  than the scribe?

---

## 8. Provenance of this file

Written 2026-09-12 from a working session about the new-evaluation Prep build.
The naming analysis and the hierarchy came out of that conversation; the
"Think Beyond AI" umbrella and the earlier competitive reasoning are reported
from prior planning that is not in this repo, so confirm those against the
original discussions before relying on them in external copy.

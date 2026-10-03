# Walkthrough findings: Interview Library + visit setup (Oct 2026)

Michael's own pass over `/practice` at `ambient-190-sub`. **Findings only. Nothing fixed yet, by
design:** fix the mental model once rather than doing five rounds of wording tweaks.

---

## F1. Setup does not communicate composition. **This is the defect.**

> The clinician cannot tell which controls determine note structure, which provide source
> material, and which add optional visit support, nor whether those choices replace or stack
> with one another.

What the screen presents as five peers:

```
  ☑ My intake template
    + Upload records   + Paste text
  ☐ ADHD interview            edit  new
  ☐ Add ADHD Evaluation Framework
  ☐ Suggest general questions for today
```

They are not peers. They are four different KINDS of thing, and three of them sound like "help
me figure out what to ask". The questions this produced, from the person who built it:

*Do these replace one another? Can I use both? What gets added where? Is the Framework another
interview? What the hell are "general questions"?*

**Losing the thread while staring at your own product is the evidence.** If the developer needs
the source code to decode the modal, the modal is doing its thinking in the developer's head
instead of on the screen.

### What each one actually is, verified in code

| control | what it is | operates on |
|---|---|---|
| My intake template | what the WORKING NOTE opens with | the Vault template |
| Upload records / Paste text | source material | the records |
| ADHD interview | the clinician's own standing questions | nothing; it is theirs |
| ADHD Framework | reasoning ABOUT this patient | the records |
| Suggest general questions | one-off questions FROM the records just added | the records |

## F2. "My intake template" does not do what its label says. **Verified.**

`draftSystem()` (`ai-scribe-practice.html:1929`) reads `vaultTemplates[visitType]` directly and
**never reads `vl-template`**. The checkbox is consumed only by `tbpVisitStart` (`:9036`), where
it picks which button to click: `neweval-setup-btn` (the intake scaffold, full screen) or
`open-blank-btn` (a blank note).

**So unchecking it does not change the drafted note at all.** It changes what is sitting in the
working window to type into.

That is a TRUST defect, not a wording one. A clinician who wants a blank working window has to
uncheck something that appears to say "do not use my template", and may reasonably conclude the
Scribe will stop writing their notes in their own format.

There are two distinct uses of the template and the UI exposes only one:

- **working window** — do you want your saved sections sitting there to type into live?
- **final draft** — the Scribe uses your saved template either way.

## F3. The checkbox and the interview picker are redundant

Once a dropdown exists, requiring BOTH a selection and a separate "use it" checkbox is clutter
by the §40 test: the second control carries no decision the first did not already carry.

The selector should carry it: `None` means do not load one. Anything else means load that one.
With exactly one saved interview and no dropdown, a checkbox still makes sense.

## F4. "Suggest general questions" is in the wrong place

It only means anything once records have been added, because it generates questions FROM those
records. Sitting it beside Interview and Framework presents it as a third standing evaluation
mode. It belongs WITH the records, appearing after they are present.

"General questions" also tells the clinician nothing.

## F5. "Add ADHD Evaluation Framework" reads as "load another ADHD form"

The label names a product object rather than what pressing it does. It is the only control on the
screen whose name does not describe its effect.

## F6. "+ Paste text" does not say what it is for

It is the paste twin of `+ Upload records` and its own placeholder says so ("intake answers, a
referral letter, an outside note, a medication list"). The button does not. The gate's
non-blocking log already flagged the related asymmetry: two doors add source material and they
do not match.

## F7. The Framework has TWO entry points on one screen, and they look like one decision

```
  ☐ Add ADHD Evaluation Framework — if ADHD is part of what you are evaluating
  ...
  Only need the ADHD Framework, without prepping a visit?  Open it on its own →
```

Both say "I want the Framework". The difference is real and is carried entirely by the clause
*without prepping a visit*:

- the **checkbox** (`ep-adhd`) adds the Framework to a visit being prepped. It does nothing until
  `Start this visit` is pressed.
- the **link** (`adhd-open-setup-link` -> `tbpAdhdEnter('framework')`) opens the Framework alone.
  No visit, no note.

A clinician who wants the Framework sees two ways to get it and no statement of what differs.

**This screen has already produced this exact defect once.** The comment above
`tbpEpSyncQuestionCopy` records it, about the Framework checkbox versus the questions checkbox:

> The two options overlapped ... Both true separately, contradictory together. So the second
> option renames itself to what it actually adds once ADHD support is on ... **Nobody should
> have to work out whether ticking one makes the other redundant.**

That fix was correct and local. The same class of overlap then reappeared between the checkbox
and the link, which is the argument for fixing the model rather than the next pair.

## F8. Visit setup has become template management. **Persistent choices belong in the Vault.**

Clicking `new` while starting a patient evaluation produces, inside the visit launcher:

- "What do you want to call this interview?"
- a full editor holding the whole question set
- `Save my interview`, `Delete this interview`
- the scaffolding-contract explanation

That is a different task from starting a visit. Creating, naming, editing, renaming, deleting and
importing reusable question sets is **persistent clinician configuration**. This screen is about
**this encounter**.

It also explains a conceptual smell in F1: `ADHD interview  edit  new` sits beside
`Add ADHD Evaluation Framework`, so `edit` and `new` read as competing options for today's
evaluation. They are not clinical decisions at all. They are account configuration wearing the
same visual weight as a clinical one.

### The rule

> **Persistent choices live in the Vault. Encounter choices live in the encounter.**

An interview is persistent. Its authoring belongs in the Vault.

### How this happened, precisely

The inline editor PREDATES the library work. `tbpRenderInterviewBlock` carries the comment
"Deliberately NOT shown: the launcher owns this now", describing the editor being relocated out
of its own block and into the launcher.

What `ambient-188-sub` added was `new`, a name field and a delete button. That turned "edit my
one interview" into full template management inside visit setup. **The misplacement was
inherited; the amplification made it visible.** Which is the argument for the walkthrough: the
defect was latent until something made it big enough to notice.

### What moves, and what does not

**Moves:** create, name, edit, rename, delete, import. Into the Vault surface that already
exists for this kind of work: the `#wizard` modal, "Set up your note templates", reached from
"Set up my templates".

**Stays in the launcher:** selection only.

```
  Interview questions:  [ None  v ]        Manage interviews
```

`None` means do not load one. Anything else means load that one. One quiet link to the Vault
surface. **No editor inline.** For a clinician with nothing saved, `Create one` may be offered,
but it opens the Vault surface rather than expanding an editor in the launcher.

**Unchanged:** `interview-library.js`, its migration, its 21 tests, `tbpInterviewSplit`, the
storage shape, the legacy mirror, and the safety contract. This is a relocation of the authoring
UI, not a redesign of the interview engine. The library architecture was right; its address was
wrong.

---

## The model the screen should communicate

Four layers that STACK. They are not competing modes.

1. **Working note layout** — blank, or start with my saved intake sections.
2. **Interview questions** — none, or one of my saved question sets.
3. **Records** — things to read before and during the visit.
4. **Optional reasoning support** — ADHD evidence and gaps; questions from the records.

Drafting is downstream and uses the saved note template regardless.

**Template and interview are not alternatives.** The most natural setup for a clinician who types
as they go is BOTH: their usual intake sections and their interview questions in the same working
window. At Draft, the Scribe writes what they actually documented, in their saved template.

### Direction, not yet designed in detail

Grouping and clearer action language, plus removing the redundant control. **Not more
explanation.** Every label should say what pressing it changes, not name the object behind it.

Candidate phrasing, to be settled when the screen is reworked:

- `Start with my intake sections` / *Preloads your working note for typing. Your final draft uses
  your saved template either way.*
- `Interview questions: [None v]` / *Adds your saved questions to the working visit. Does not
  change your note template.*
- `Track ADHD evidence and uncertainty` / *Organizes what the records and the visit support, what
  conflicts, and what still needs clarification. Works with or without an interview.*
- `Suggest follow-up questions from these records`, shown with the records
- `+ Paste records`
- the Framework's two doors resolved: either the standalone link states what it does NOT do
  ("opens the Framework by itself, with no visit note"), or the distinction becomes a property of
  one control rather than two separate ones

### A product point that falls out of this

Framework without an interview is a real use case, not an edge case: a clinician with their own
natural interview who wants the Scribe only to say what the neuropsych report establishes, where
the childhood-onset gap is, what contradicts what, and what today changed. Interview without
Framework is equally real.

**Use as much or as little structure as you want. Your interview stays yours; Think Beyond can
sit beside it and track the evidence.** That is a selling point, and the current screen hides it.

---

## Still to walk

Steps 3 to 7 of the pass: create/import a second interview, the picker with two present, starting
a visit with a custom one, answering some and drafting, and the reload. Findings continue here.

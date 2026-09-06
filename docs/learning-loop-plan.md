# Plan v1.0 — close the learning loop: record the judgement, take the correction

*Stress-tested across all 10 dimensions per `sop/stress-test-10-dimensions.md`;
absorption notes in §9. Draft — not ratified.*

## 1. What is broken

`src/store/db.ts` has a `decisions` table whose own comment states the case:

> *Every judgement the system made, and what Mahi said it should have been. The
> substrate under every way this can improve. Few-shot needs examples,
> retrieval needs stored decisions, LoRA needs graded pairs, DPO needs
> chosen-against-rejected — all four are these rows.*

The table works. The loop around it does not close at either end.

```
decision made  ──▶  recorded?    taxonomy only — 1 of 3 judgements
               ──▶  corrected?   NO PATH EXISTS — recordCorrection is called from tests only
               ──▶  fed back?    yes, taxonomy only, from a table nothing can write to
```

Three specific gaps, each verified in the source:

**The agent's judgement is thrown away.** `record_contact`
(`tools/index.ts:276`) calls `recordContact` and never `recordDecision`. It has
`input.reasoning` in hand — *"why this person rather than the others"* — and
drops it. The most expensive and most valuable judgement in the system records
nothing gradeable.

**"Nobody is reachable" leaves no trace at all.** `record_no_contact`
(`tools/index.ts:342`) calls only `ctx.onFinish`. Not a contact row, not a
decision row, nothing. After the process exits, a run that correctly concluded
a company has nobody approachable is indistinguishable from a run that never
happened.

**Mahi cannot tell the system it was wrong.** `recordCorrection` exists, is
tested, and is called from **no** production code path. There is no command, no
flag, nothing.

## 2. What "closed" means here

Writing decisions is only half. A write-only log teaches nothing. The loop
closes when the next run **reads** what it was told last time — which is
already how `taxonomy.ts:358` works, and is the pattern to copy:

```
  record ──▶ correct ──▶ feed back into the next prompt ──▶ record
```

`correctionsFor(kind, subjectPrefix, recent)` already does the read. Nothing
new is needed on that side.

## 3. The shape

### 3.1 Record the contact judgement

Both commit tools write a decision. `record_contact` records the person and the
reasoning it already collects; `record_no_contact` records the conclusion and
the reason it already collects.

```
kind      'contact'
subject   the role id — `company::unit::roleCore`
context   { title, company, companyLinkedinUrl, posterName }
chose     { name, title, profileUrl, observation } | { found: false }
reasoning input.reasoning, or input.reason
decider   the model label
```

**Subject is the role id, not the job id.** `correctionsFor` does a `LIKE`
prefix match, and a role id starts with the company, so *"at this company the
recruiter is never the right contact"* generalises to every future role there.
A job id generalises to nothing — the posting is gone in a month (#6.b).

### 3.2 The decider has to be plumbed

`EnrichToolContext` carries `jobId`, `transcript`, `onFinish` and `charge`. It
does **not** carry the model label, and a decision with no `decider` cannot be
used to compare two models — which is the entire point of the eval work. The
label already exists in `run.ts:126` as `label` from `buildEnrichAgent`. It gets
added to the context (#3.c).

### 3.3 The correction path

```
npm run queue -- --wrong <job-id> --note "the recruiter posted it; the Head of Product owns the team"
```

In `queue.ts` because that is where Mahi already is when he notices. It finds
the most recent `contact` decision for that posting's role, and calls
`recordCorrection`.

**The note is required, and this one does refuse.** Different from `--declined`,
deliberately: a decline without a note still records the fact that they said no,
which is worth having on its own. A correction without a note records *nothing
usable* — `correction_note` is the column that generalises, and an empty one
puts a row in the table that no future prompt can learn from. Refusing loses
nothing (#5.c).

### 3.4 Feed it back

`enrichGoal()` gains a corrections block, built exactly like
`taxonomy.ts:358-361`:

```
WHAT I HAVE BEEN TOLD BEFORE about this company:
  - the recruiter posted it; the Head of Product owns the team
```

Capped at the 3 most recent, as `correctionsFor`'s default already does.

## 4. Changes

| file | change |
|---|---|
| `src/agent/tools/index.ts` | both commit tools call `recordDecision`; `EnrichToolContext` gains `decider` |
| `src/agent/run.ts` | passes the model label into the context |
| `src/agent/enrich-agent.ts` | `enrichGoal` takes and renders corrections |
| `src/queue.ts` | `--wrong <id> --note "..."`, note required |
| `src/store/db.ts` | `latestDecisionFor(kind, subject)` — the lookup `--wrong` needs |
| `src/store/learning.test.ts` | new, ~10 tests |
| `CLAUDE.md` | the loop, and that a decision's subject is the role id |

## 5. Sequence

1. `git checkout -b feat/learning-loop`
2. `decider` into `EnrichToolContext`, threaded from `run.ts` — typecheck proves
   every construction site is updated
3. `recordDecision` in both commit tools, with tests
4. `latestDecisionFor` + `--wrong` in `queue.ts`, with tests
5. `enrichGoal` renders corrections; test that a correction reaches the prompt
6. `npm test`, `npm run typecheck`, `CLAUDE.md` and journal in the same commit

**No agent run is needed to verify any of this.** Steps 3–5 are all testable
against a temp database with a fabricated tool context, so this session spends
nothing (#4.d).

## 6. Done when

An enrichment run leaves a `contact` decision with a decider and reasoning;
`npm run queue -- --wrong <id> --note "..."` attaches a correction to it;
`enrichGoal` for another posting at that company contains the note; and
`--wrong` without a note refuses.

## 7. What this does not do

- **It does not make the agent learn automatically.** Nothing retrains, nothing
  rewrites a prompt. Corrections are shown to the model as prior instruction,
  which is few-shot, not learning. The heavier paths — retrieval, LoRA, DPO —
  read these same rows later and none of them are in scope.
- **It does not record screening or scoring decisions.** Those are deterministic
  and already explainable through `gates`. `decisions` is for judgements a model
  made and a human may overrule.
- **It does not correct a taxonomy.** `--wrong` covers `contact` only; taxonomy
  corrections already have a path through `roles.ts`.

## 8. Risks accepted

- **A bad correction poisons every future run at that company.** It goes into
  the prompt verbatim and nothing weighs it. Mitigated only by the cap of 3 and
  by Mahi writing them — see finding 10.a, which recommends an un-correct path
  and defers it.
- **Corrections are Mahi's opinion, not outcomes.** The same limit the eval case
  set carries. Real outcomes now exist in `outcomes` and are the better signal;
  wiring those into the loop is deliberately a later step.

---

## 9. v1.0 10-dimension stress-test absorption notes

All 10 walked. 29 findings, 13 actionable. The #7 state-machine sub-analysis is
**NOT triggered** — this change adds no state, writes no `jobs.state`, and
increases traffic into none. Documented so the skip is deliberate.

### 9.1 #1 Edge cases (7 findings, 6 actionable)

- 1.a: `--wrong` on a posting with **no** contact decision — never enriched, or
  enriched before this shipped. **ACTIONABLE §3.3** — say so and refuse, rather
  than creating a correction attached to nothing.
- 1.b: `--wrong` twice on the same decision. `recordCorrection` overwrites
  `correction_note`, silently losing the first. **ACTIONABLE §4** — append, the
  same rule `recordOutcome` uses for its note, or explicitly refuse the second.
- 1.c: a posting whose `role_id` is NULL. `roleOf(jobId)` returns null and the
  subject cannot be built. Possible for a posting enriched before grouping
  existed. **ACTIONABLE §3.1** — fall back to the job id as subject and say so
  in the row, rather than throwing.
- 1.d: `record_no_contact` fires when the run found nobody **because a source
  was blocked**. Recording that as "no contact exists at this company" is a lie
  the whole way up — the exact failure `ActorBlockedError` was built for.
  **ACTIONABLE §3.1** — the decision records the reason text verbatim and does
  not collapse it to a boolean.
- 1.e: a correction note containing a newline or a quote character, pasted from
  an email. It lands in a prompt. **ACTIONABLE §3.4** — collapse whitespace and
  cap the length when rendering, as `taxonomy.ts` does for its excerpts.
- 1.f: more than 3 corrections at one company. `correctionsFor` defaults to
  `recent = 3` and orders by recency. ✓ (no action — the cap already exists.)
- 1.g: the same company under two casings — `Bjak` and `BJAK` both exist in the
  store. A prefix match on a role id is already lowercased by `roleKey`, so both
  resolve to the same prefix. **ACTIONABLE §4** — assert this in a test, because
  it is true by accident of `roleKey` rather than by design here.

### 9.2 #2 Unverified assumptions (6 findings, 3 actionable)

- 2.a ✓ VERIFIED: `recordDecision({ kind, subject, context, chose, reasoning?,
  decider })` returns the new id, and `DecisionKind` already includes
  `'contact'` — no type change needed.
- 2.b ✓ VERIFIED: `correctionsFor(kind, subjectPrefix, recent = 3)` filters on
  `corrected_at IS NOT NULL` and does a `LIKE` prefix match, so an uncorrected
  decision is never offered as a lesson.
- 2.c **FALSE**: the assumption that the tool context can identify the model.
  `EnrichToolContext` is `{ jobId, transcript, onFinish, charge }` — there is no
  decider. A decision written without one is unusable for the model comparison
  the eval work exists to run. **ACTIONABLE §3.2.**
- 2.d **PARTLY FALSE**: the assumption that `record_no_contact` records
  something. It calls only `ctx.onFinish`, which is an in-memory callback. The
  conclusion does not survive the process. **ACTIONABLE §3.1.**
- 2.e ✓ VERIFIED: `roleOf(jobId)` exists and joins `jobs.role_id` to `roles`, so
  the subject is derivable inside the tool without a new query shape.
- 2.f: the assumption that a posting reaching the agent always has a `role_id`.
  It is `scored`, and everything `scored` is grouped today — but that is a
  property of the current store, not an invariant anything enforces.
  **ACTIONABLE §3.1** — see 1.c's fallback.

### 9.3 #3 Actual code checks (6 findings, all verified)

- 3.a ✓ `tools/index.ts:276-327`: `record_contact` calls `recordContact` at :322
  and `ctx.onFinish` at :324. No `recordDecision`. It already collects
  `input.reasoning`, described as *"Why this person rather than the others"* —
  the exact field a decision wants.
- 3.b ✓ `tools/index.ts:342-357`: `record_no_contact` calls `ctx.onFinish` only.
  Its `reason` field already asks the model to *"say plainly if a source
  returned nothing rather than the company having nobody"*, which is precisely
  the distinction finding 1.d needs preserved.
- 3.c ✓ `EnrichToolContext` (`tools/index.ts`) has four fields and no decider;
  `run.ts:126` destructures `label` from `buildEnrichAgent` and `run.ts:129`
  builds the context without it. The plumbing is one field through one call.
- 3.d ✓ `taxonomy.ts:358-361` is the working precedent: `correctionsFor` →
  filter blank notes → render into the prompt under a heading. Copy it rather
  than invent a second shape.
- 3.e ✓ `decisions` has an index on `(kind, subject)`, so a prefix lookup per
  run is cheap.
- 3.f ✓ `queue.ts` already has the `flag()` helper and the `jobExists` refusal
  pattern from outcome capture, so `--wrong` costs no new scaffolding.

### 9.4 #4 Security (5 findings, 2 actionable)

- 4.a ✓ VERIFIED: `db.ts`'s own comment already anticipates this —
  *"kind is open so contact and draft decisions land here too, and those name
  real people."* A `contact` decision's `chose` holds a real name and profile
  URL. The database is outside the repo; `.gitignore:23` covers `data/`.
- 4.b: `context` would carry the job description if copied wholesale.
  **ACTIONABLE §3.1** — store the four identifying fields listed, not the raw
  posting. A decision is a judgement record, not an archive.
- 4.c: a correction note is free text Mahi writes and it is later **interpolated
  into a model prompt**. That is prompt injection with Mahi as the only author,
  which is an acceptable trust boundary — but the rendering must still be
  bounded. **ACTIONABLE §3.4** — cap length, collapse whitespace.
- 4.d ✓ No spend. Steps 3–5 are testable with a fabricated tool context against
  a temp database; no agent run and no Apify call is needed to verify any of it.
- 4.e ✓ No new dependency.

### 9.5 #5 Vision alignment (4 findings, 1 actionable)

- 5.a ✓ ALIGNED: `vision.md` calls the bet *"if a 3-billion-parameter model can
  do that judgement"*. Comparing models needs decisions labelled with a decider,
  which is exactly what 2.c blocks today.
- 5.b ✓ ALIGNED: `roadmap.md` says *"start recording outcomes. This is worthless
  retroactively and cheap now."* The same argument applies to judgements, and
  the table has been sitting empty since it was built.
- 5.c: `vision.md` insists rejections stay explainable. **ACTIONABLE §3.3** —
  `--wrong` requires a note and refuses without one, unlike `--declined`. The
  asymmetry is deliberate: a decline without a note still records that they said
  no; a correction without a note records nothing a future prompt can use.
- 5.d ✓ ALIGNED: `roadmap.md` explicitly rules out self-improving agents. This
  plan shows corrections to a model as prior instruction and nothing rewrites
  itself — §7 states that boundary.

### 9.6 #6 Architecture consistency (4 findings, 2 actionable)

- 6.a ✓ The `decisions` table, `recordDecision`, `recordCorrection` and
  `correctionsFor` all already exist and are tested. This plan adds callers, not
  substrate.
- 6.b: subject shape is the load-bearing design choice and it is easy to get
  wrong. **ACTIONABLE §3.1** — the role id, because `correctionsFor` prefix
  matches and a role id starts with the company, so a lesson generalises to
  every future role there. A job id generalises to nothing.
- 6.c ✓ Constraining versus informing: this informs. Corrections are shown to
  the model, not enforced on it, consistent with `CLAUDE.md`'s rule that only
  money and fabrication are constrained in-band.
- 6.d: `--wrong` in `queue.ts` rather than a new CLI. **ACTIONABLE §3.3** — the
  correction is worth having only if it is typed, and Mahi is already in the
  queue when he notices the contact was wrong. A separate command is one he
  would have to remember exists.

### 9.7 #7 Impact on other features (4 findings, 1 actionable)

**State-machine sub-analysis: NOT TRIGGERED.** No state is added, no
`jobs.state` is written, and traffic into no state increases. Recorded so the
skip is deliberate rather than forgotten.

- 7.a: `enrichGoal()` gains an argument, and it is called from `run.ts` and will
  be called from the §2.3 experiment runner. **ACTIONABLE §4** — corrections
  default to empty so an eval run is reproducible and not silently altered by
  whatever Mahi typed last week. An eval that reads live corrections is not a
  controlled comparison.
- 7.b ✓ `record_contact`'s grounding refusal and `record_no_contact`'s
  completion semantics are untouched. The decision write happens after the
  existing checks pass, so a REFUSED call records nothing.
- 7.c ✓ The eval scorers read runs through Mastra's extractors, not through
  `decisions`, so nothing in `src/eval/` changes behaviour.
- 7.d ✓ `--wrong` is a new flag; verified against `queue.ts`'s existing flags
  (`--skip`, `--sent`, `--accepted`, `--replied`, `--declined`, `--contact`,
  `--note`) — no collision.

### 9.8 #8 Test coverage (4 findings, 3 actionable)

- 8.a: the tools are testable without a model by calling `execute` directly with
  a fabricated context. **ACTIONABLE §4** — assert that a committed contact
  leaves a decision with the decider set, and that a REFUSED grounding leaves
  none.
- 8.b: the round trip is the test that matters. **ACTIONABLE §4** — record a
  decision, correct it, then assert the note appears in `enrichGoal` output for
  a *different* posting at the same company. That single test proves the loop
  closes; the others only prove pieces.
- 8.c: `--wrong` with no note must refuse, and `--wrong` on a posting with no
  decision must refuse. **ACTIONABLE §4.**
- 8.d: baseline **227**; target **~240**. (no action beyond recording it.)

### 9.9 #9 Deployment & rollback (3 findings, 0 actionable)

- 9.a ✓ No schema change — `decisions` already exists with every column this
  needs. No migration, no deploy.
- 9.b ✓ Rollback is reverting the commit. Rows already written are inert: if the
  callers go away, `correctionsFor` simply stops being called and the rows sit
  there.
- 9.c ✓ Additive to live data. Nothing is deleted or rewritten, unlike the
  outcome-capture session.

### 9.10 #10 Risks (5 findings, 2 actionable)

- 10.a: **a bad correction poisons every future run at that company**, verbatim
  and unweighted. There is no un-correct path. Blast radius: every enrichment at
  that company until somebody notices. **ACTIONABLE §8** — named as accepted,
  and an `--unwrong` is the obvious follow-up. Deferred rather than added,
  because a delete path on a table built to be an audit trail deserves its own
  decision.
- 10.b: **write-only is the failure mode to avoid.** Recording decisions without
  §3.4's feedback would produce a growing table nobody reads, which is what the
  taxonomy path already avoids. **ACTIONABLE §5** — step 5 is not optional and
  must land in the same session.
- 10.c: corrections are Mahi's opinion, not outcomes. `outcomes` now exists and
  is the stronger signal. Accepted (§8); wiring outcomes into the loop is a
  later step and a better one.
- 10.d: prompt growth. Three corrections at ~200 characters is ~600 characters
  against a goal that already carries 3,000 characters of job description.
  Immaterial for hosted models; measurable for a 4B with a small window.
  (no action — the cap already bounds it.)
- 10.e: this session is the first to write to `decisions` from an unattended
  path. A bug writes rows on every enrichment. Mitigated by the write being
  after the existing refusals (7.b) and by the table being append-only.

### 9.11 Net v1.0 changes

| Finding | Section | Change |
|---|---|---|
| 2.c | §3.2 | `EnrichToolContext` gains `decider` — without it a decision cannot serve the model comparison it exists for |
| 2.d | §3.1 | `record_no_contact` currently records **nothing at all**; the conclusion must survive the process |
| 6.b | §3.1 | Subject is the role id, so a lesson generalises to the company rather than to one dead posting |
| 1.d | §3.1 | A blocked source must not be recorded as "this company has nobody" — the reason text is kept verbatim |
| 7.a | §4 | `enrichGoal` corrections default to empty, so an eval run stays a controlled comparison |
| 10.b / 5 | §5 | Step 5 (feed back) is not optional — record-without-read is a table nobody reads |
| 1.b | §4 | A second correction appends rather than overwriting the first |
| 1.c / 2.f | §3.1 | A NULL `role_id` falls back to the job id rather than throwing |
| 5.c | §3.3 | `--wrong` requires a note and refuses without one — unlike `--declined`, and deliberately |
| 4.b | §3.1 | Store four identifying fields as context, not the raw posting |
| 4.c / 1.e | §3.4 | Cap and whitespace-collapse a note before it enters a prompt |
| 1.g | §4 | Test that `Bjak` and `BJAK` share a correction prefix — true today by accident of `roleKey` |
| 8.b | §4 | The round-trip test is the one that proves the loop closes |
| 10.a | §8 | No un-correct path; named as accepted, `--unwrong` deferred deliberately |

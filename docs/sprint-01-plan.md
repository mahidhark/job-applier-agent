# Sprint 1 — the evaluation harness

*v2.1. Supersedes v2.0. The sprint stopped at step 4 of 6; this amendment
unblocks the rest. §2.3 was specified against an API that does not exist and
contradicted this document's own finding 2.a — both are resolved here, and the
resolution is smaller than either problem looked. Stress-tested across all 10
dimensions per `sop/stress-test-10-dimensions.md`; v2.0 notes in §7, v2.1 notes
in §8.*

*v2.0 superseded v1.0, which was written before the Mastra refactor and before
seven harness faults showed that measurement, not capability, was the blocker.*

## 1. Goal

Make a claim about an agent that survives scrutiny.

Today the system can say "Claude took 10 tool calls, Cerebras took 5." It
cannot say whether either found the right person. Every model comparison so far
has been one anecdote read by hand, and seven times the anecdote was wrong
about the model because the harness was wrong about the run.

Sprint 1 ends when `npm run experiment` runs a labelled case set through two
providers and prints a table.

Out of scope: infrastructure, local inference, fine-tuning, drafting notes,
anything that sends.

## 2. Work

### 2.1 Case set — the dependency, and it needs Mahi

Ten cases. Each is a posting plus the answer.

```
job_id, company, company_linkedin_url,
expected_contact_name, expected_contact_url, expected_reason,
shape: names_nobody | names_recruiter | ambiguous_company | nobody_findable
```

Coverage is by shape, not count. **At least two must be `nobody_findable`**,
where the correct answer is that no contact exists — an agent that invents one
fails, an agent that says "I found no one" passes. Fabricating a person is the
worst failure this system has, and nothing currently tests for it.

`src/eval/prepare-cases.ts` pulls ten scored postings, resolves each company,
lists the people found, and writes `data/cases/draft.json` pre-filled with
everything verifiable. Mahi fills in the expected contact and the shape.
Estimated: twenty minutes of his time. **Nothing downstream can start without
this**, because a case set I write myself grades the agent against my own
reasoning rather than against being right.

Split ten into **seven tune / three held-out**. Prompt and tool changes are
measured on the seven; the three are only ever run to confirm a change
generalised. Without the split, tuning until the scores rise is overfitting
that looks like progress.

### 2.2 Scorers

`src/eval/scorers/` using `createScorer` from `@mastra/core/evals`.

Deterministic first — free, and they cannot themselves hallucinate:

| scorer | checks |
|---|---|
| `answered` | committed a contact, or correctly committed none |
| `right_company` | the contact works at the target company |
| `grounded` | wraps the existing `checkGrounding`; its 9 tests move here |
| `no_fabrication` | on `nobody_findable` cases, committing anyone is a fail |
| `efficiency` | tool calls, spend, wall time — reported, not pass/fail |

One judged scorer, last: `right_person` — is this plausibly who decides? It runs
**blind to which model produced the answer**, or a comparison judged by one of
its own contestants flatters that contestant.

#### What §2.2 actually shipped (deviations, for ratification)

Three changes against the table above. None were forced by a blocker; each was
a better answer found while building, so each needs Mahi's yes or no.

**v2.1 status: all three still unratified.** They shipped on 2026-09-04 and have
been pending since. `[Mahi-verify]` — see finding 10.d. §2.3 depends on (2)
being accepted, because it wires `GATES` and `SCORERS` in the shape (2) created.
The v2.1 recommendation is to ratify all three; (2) is the strongest of them.

1. **`@mastra/evals` added as a dependency.** The plan assumed `createScorer`
   and nothing else. `@mastra/evals/scorers/prebuilt` ships
   `createTrajectoryScorerCode`, which grades four dimensions at once —
   expected-step accuracy, efficiency (`maxSteps`, `noRedundantCalls`),
   forbidden tools, and tool-failure patterns. That is strictly more than the
   loop detector this project would have written, and it is tested upstream.
   Stress-test finding 2.c asked for a trajectory scorer; this is it, not built
   here. Its test utilities (`createAgentTestRun`, `createTrajectoryTestRun`)
   also mean the scorer tests construct runs the way the framework does rather
   than the way we guess it does — which is how a renamed field once turned a
   working model into a reported fabricator.

2. **`right_company` became `right_contact`, and `no_fabrication` was
   re-scoped.** The plan had `no_fabrication` mean "on a `nobody_findable`
   case, naming anyone fails". That is now `right_contact`'s job: a
   `nobody_findable` case has an empty acceptable list, so committing nobody is
   the correct answer and one scorer covers both directions. `no_fabrication`
   instead asks, on every case, whether the person named appears anywhere in
   what the tools returned. The split matters: naming a real employee who is
   not the best contact is a judgement call, naming somebody who does not exist
   is the one failure that reaches a stranger's inbox. Collapsed into one
   scorer, both read 0 and the difference disappears. Nothing now checks
   employer independently for a contact *not* on the accepted list — the judged
   `right_person` rubric covers it, and that is a real (small) gap.

3. **`efficiency` dropped as a scorer.** Redundancy and step budget are inside
   the trajectory scorer; cost and wall time are facts to report, not tests to
   pass, and they belong in §2.3's table. A scorer that never passes or fails
   only exists to be averaged into something meaningless.

Also fixed while here: `npm test` ran `src/**/*.test.ts` unquoted, which the
shell expands one level deep. Every test nested two levels down had never run.
Quoting it hands the glob to Node. Suite went 44 → 75, of which 31 are new.

### 2.3 Experiment runner

*v2.1: rewritten. v2.0 specified `dataset.startExperiment()`, which does not
exist at the installed versions, and which contradicted finding 2.a of this
document's own stress test. Both have one resolution, and it removes work
rather than adding it.*

`src/eval/experiment.ts`, driven by **`runEvals` from `@mastra/core/evals`** —
verified present at `@mastra/core` 1.64.0, `@mastra/evals` 1.10.0:

```
runEvals({ data, scorers, gates, target, targetOptions, onItemComplete, concurrency })
```

**`data` is a plain array.** `runEvals` iterates it with `pMap`. There is no
Dataset type to construct, no `startExperiment` to call, nothing to register. So
"keep cases in our own store" (finding 2.a) and "use Mastra's runner" were never
alternatives — v2.0 invented the choice, and the library does not pose it.

**Storage is optional.** `const mastra = target.getMastraInstance?.() ||
target.mastra; const storage = mastra?.getStorage();`, and every persist path is
guarded `if (storage)`. No Mastra instance, no LibSQL, one database — which is
what findings 2.a and 6.b asked for, now verified instead of assumed. Results
persist to our own SQLite from `onItemComplete`.

**The scorers already fit.** `src/eval/scorers/index.ts` exports `GATES`,
`SCORERS` and `HARNESS_SCORERS`, which is the exact shape
`runEvals({ gates, scorers })` consumes. §2.2 built them compatible without
anyone wiring them.

What this file owns, because Mastra does not:

- **Three runs per cell, and variance — not just means.** Claude picked Tiffany
  on one run and Ingmar on two others from identical input. A single run per
  cell reports that as a difference between models.
- **An unscoreable run is not a zero.** `runEvals` catches a throwing gate and
  pushes `0` for it. That is precisely the mistake this project has paid most
  for: seven reported model failures in one afternoon were all harness faults.
  `UnscoreableRun` must be caught before it reaches a gate and recorded as
  *unscoreable*, never averaged in as a failure. **This is the most important
  requirement in §2.3**, and it is the one thing Mastra's default gets wrong for
  this project.
- **Replay.** `collectToolMocks`, imported from `@mastra/core/evals` — note the
  path, it is not under `@mastra/evals/scorers/utils` where finding 2.d implied
  it lived. A graded run then costs no Apify spend and survives an outage.
- **Refusal over a table with holes in it.** Fewer cases than `validateCases()`
  accepts, or an unconfigured provider, stops that cell with a stated reason.

`concurrency` defaults to 1 and **stays 1 for ollama**: a 13k prompt into a 4k
window across four parallel slots is a recorded harness fault, not a hypothesis.

`rightPerson(model)` is a factory rather than a scorer instance. The runner
constructs it with the judge model and passes the case only through
`judgeContext`, so the judge stays blind by construction.

### 2.4 Outcome capture

Separate from scoring, and worthless retroactively — every day without it is
evidence that cannot be recovered.

- `outcomes` table: `job_id`, `contact_url`, `channel`, `sent_at`,
  `accepted_at`, `replied_at`, `outcome`, `note`. Third-party personal data:
  never exported, never committed.
- `npm run queue -- --sent | --accepted | --replied | --rejected <id>`
- `npm run status` reports acceptance and reply rate over 30 days.

`jobs.state` stops at `queued`. Everything after contact lives in `outcomes`,
so there is one authority rather than two drifting state machines.

### 2.5 Two fixes today's runs exposed

**`answered_none`.** The runner currently labels "searched properly, honestly
found nobody" as failure, while the prompt explicitly instructs the model not
to call `record_contact` in that case. Correct behaviour scored as failure.

**Actor liveness.** `linkedin-profile-search` returned zero rows for every
company on 2026-09-04, Booking.com included. A tool returning empty for
*everything* is an outage, not an answer. Record per-actor non-empty rates;
surface a degraded actor in `npm run status`; pass that fact to the agent so
"this source is struggling" is information it has rather than a guess it makes.

## 3. Tests

*v2.1: the v2.0 baseline of 29 is long stale — the suite is at **212** as of
2026-09-06, and the quoted test glob that made 31 of them run again is itself a
§2.2 side-effect. Baseline **212**; §2.3 and §2.4 together target **~230**.*

- `scorers/*.test.ts` (~12): each deterministic scorer against fixtures,
  including a `nobody_findable` case where committing anyone must fail.
- `grounding.test.ts` (9): moves under the scorer, unchanged.
- `outcomes.test.ts` (~6): transitions, idempotent marking, rate arithmetic
  with a zero denominator, replied-without-sent.
- `liveness.test.ts` (~4): three consecutive empties flags; two does not; a
  recovery clears; an errored call is not counted as an empty one.

Not unit-tested, deliberately: the judged scorer. Its correctness is a matter
of agreement with Mahi, which the case set measures.

## 4. Sequence

*v2.1: annotated with what actually happened. The sprint stopped after step 4,
and steps 5-6 were displaced by six PRs of roles, grouping and paid-discovery
work. Some of that was forced — Bjak was about to take eight queue slots and
eight paid lookups for one job — but **no decision to reorder was ever
recorded**, and the plan went on claiming §2.3 was next. Recording it here is
the point of this line.*

| # | Step | Status |
|---|---|---|
| 1 | `git checkout -b feat/eval-harness` | done |
| 2 | §2.5 fixes | done |
| 3 | §2.1 `prepare-cases.ts`, hand the sheet to Mahi | **generator built; sheet never graded — `data/cases/` does not exist** |
| 4 | §2.2 scorers | done, three deviations unratified |
| 5 | §2.3 experiment runner | not started |
| 6 | §2.4 outcome capture | not started |

Revised order from here, per Mahi 2026-09-06 — **§2.4 before §2.3**, inverting
v2.0. §2.4 is the one that is worthless retroactively: every day without outcome
capture is evidence that cannot be recovered, and it is the cheaper of the two.
§2.3 cannot produce a number until §2.1 is graded regardless, and §2.1's long
pole is twenty minutes of Mahi's time, not code.

1. **§2.4 outcome capture** — branch `feat/outcome-capture`
2. **§2.1 graded case set** — in parallel; `cases:prepare` SPENDS and needs
   explicit approval as a paid call
3. **§2.3 experiment runner**, as amended above
4. `npm test`, `npm run typecheck`, journal in the same commit, push

## 5. Done when

`npm run experiment -- --providers anthropic,cerebras` prints per-case scores
and a summary table across three runs per cell, and a deliberate regression
(reverting the wrapped tools) shows up as a score drop rather than needing to
be spotted by eye.

## 6. Risks accepted

- **The case set encodes Mahi's judgment, not ground truth.** A contact he
  thinks is right may never reply. Loop 2 (real outcomes) eventually corrects
  this; Loop 1 is what can run this week.
- **Ten cases is small.** It will catch large regressions and miss subtle
  ones. Growing it is cheap once the runner exists.
- **The upstream actor outage may persist**, so some rows read "source down"
  rather than an answer. Those are worth keeping as cases in their own right.

---

## 7. v2.0 10-dimension stress-test absorption notes

All 10 walked. 26 findings, 11 actionable. Four change the plan materially and
are listed first in §7.11.

### 7.1 #1 Edge cases (5 findings, 2 actionable)

- 1.a: a case whose company no longer exists on LinkedIn, or was renamed after
  labelling. The expected URL then points at nothing and the scorer fails a
  correct agent. **ACTIONABLE §2.1** — store the company URL *and* the name;
  `right_company` matches on either.
- 1.b: two people at one company are both defensible answers — a Head of
  Product and a founder at a 60-person company. A single `expected_contact_url`
  marks one correct answer wrong. **ACTIONABLE §2.1** — allow a list of
  acceptable contacts per case, not one.
- 1.c: `nobody_findable` where the agent finds someone *real* but not the
  hiring manager. That is not fabrication, and scoring it as one conflates two
  different failures. **(no action)** — `no_fabrication` checks only that the
  committed contact exists in tool output; `right_person` judges suitability.
- 1.d: zero denominator in acceptance rate before anything is sent.
  **(no action)** — covered by planned tests.
- 1.e: an experiment interrupted mid-run leaves partial results. **(no action)**
  — `startExperiment` persists per item; a rerun overwrites by case id.

### 7.2 #2 Unverified assumptions (5 findings, 3 actionable)

- 2.a: **the plan assumed Datasets work standalone. They do not.** Verified in
  the Mastra docs: *"Datasets require a storage adapter that provides the
  `datasets` domain"*, configured on a `Mastra` instance (`new Mastra({ storage:
  new LibSQLStore(...) })`). We construct `Agent` directly and have no Mastra
  instance and no LibSQL. **ACTIONABLE §2.1/§2.3** — either stand one up, which
  means a second database beside our better-sqlite3 store, or keep cases in our
  own store and use only `createScorer`. See 7.11.
- 2.b: `createScorer` import path. **✓ VERIFIED** — `@mastra/core/evals`
  exports `createScorer` and `MastraScorer`.
- 2.c: **the module also exports `extractTrajectory`,
  `extractTrajectoryFromTrace` and `collectToolMocks`, none of which the plan
  used.** Trajectory scoring grades the *sequence* of tool calls rather than
  the final answer — which is precisely what separated raw MCP (18 searches, no
  reads) from wrapped tools (resolve, search, refine). **ACTIONABLE §2.2** — add
  a trajectory scorer; it measures the thing today's biggest finding was about.
- 2.d: `collectToolMocks` implies the agent can be run against recorded tool
  output. **ACTIONABLE §2.3** — an eval that replays fixtures costs no Apify
  credit and is immune to the outage that confounded every run today. Live runs
  then become an occasional check rather than the only mode.
- 2.e: test baseline 29. **✓ VERIFIED** by `npm test`.

### 7.3 #3 Actual code checks (4 findings, 1 actionable)

- 3.a: `JOB_STATES` is `seen, rejected, scored, enriched, queued, sent,
  skipped` — it already contains `sent`. **ACTIONABLE §2.4** — the outcomes
  table would be a second state machine over the same idea. `jobs.state` stops
  at `queued`; `sent` is removed from the enum or documented as unused.
- 3.b: `checkGrounding` returns `grounded | not_found | uncheckable |
  no_claim`. A scorer must map `uncheckable` to *no score*, never to zero, or a
  harness fault becomes a model penalty. **✓ ALIGNED**, and the reason the
  verdict exists.
- 3.c: `record_contact` already refuses ungrounded commits, so a committed
  result is grounded by construction and `grounded` will be near-constant on
  committed answers. **(no action)** — its value is catching a regression that
  removes the refusal.
- 3.d: `src/agent/run.ts` writes traces to `data/runs/*.json`. **(no action)**
  — superseded if Mastra storage lands.

### 7.4 #4 Security (3 findings, 1 actionable)

- 4.a: the case set and outcomes hold named third parties and profile URLs.
  **ACTIONABLE §2.1/§2.4** — `data/cases/` gitignored alongside `data/`, and a
  schema comment stating this is personal data about people who did not consent
  to being in a database.
- 4.b: a judged scorer sends posting and profile text to a model provider.
  **(no action)** — same exposure the agent already has.
- 4.c: no new credentials, no new network surface. **(no action)**

### 7.5 #5 Vision alignment (2 findings, 0 actionable)

- 5.a: vision.md names the intolerable outcome as "not knowing". This sprint is
  that, directly. **✓ ALIGNED**
- 5.b: nothing here adds or eases a send path. **✓ ALIGNED**

### 7.6 #6 Architecture consistency (2 findings, 1 actionable)

- 6.a: scorers belong beside the agent, not inside it. `src/eval/` is a
  sibling of `src/agent/`. **✓ ALIGNED**
- 6.b: if Mastra storage lands, two stores exist — ours for pipeline state,
  LibSQL for eval. **ACTIONABLE §2.3** — point LibSQLStore at a separate file
  under `data/` and state plainly that eval state is disposable while pipeline
  state is not, or the distinction rots.

### 7.7 #7 Impact on other features (3 findings, 1 actionable)

- 7.a: **state-machine sub-analysis, triggered.** Outcomes add states after
  contact while `jobs.state` already has `sent`. Producers: `queue.ts` only.
  Consumers: `status.ts`, `explain.ts`. UI: CLI flags. Parity holds only with
  one authority. **ACTIONABLE §2.4**, same as 3.a.
- 7.b: the `answered_none` fix changes what every historical trace in
  `data/runs/` means. **(no action)** — those are exploratory, not a baseline.
- 7.c: liveness affects the agent's prompt (it is told a source is degraded),
  so an eval run and a production run see different context. **(no action)** —
  but the case set must record which mode it ran in.

### 7.8 #8 Test coverage (3 findings, 1 actionable)

- 8.a: ~31 new tests planned. **✓**
- 8.b: nothing tests that a scorer maps `uncheckable` to no-score rather than
  zero, which is the single failure that would re-import today's worst bug.
  **ACTIONABLE §3** — an explicit test.
- 8.c: the judged scorer is untested by design. **(no action)** — stated.

### 7.9 #9 Deployment & rollback (2 findings, 0 actionable)

- 9.a: nothing runs under pm2 for this repo; rollback is `git revert` on an
  unmerged branch. **(no action)**
- 9.b: the outcomes table is additive; no migration of existing rows.
  **(no action)**

### 7.10 #10 Risks (2 findings, 1 Mahi-verify)

- 10.a: ten cases catches large regressions and misses subtle ones. Accepted;
  growing the set is cheap once the runner exists.
- 10.b: the case set encodes Mahi's judgment of who the right contact is, and
  every score inherits it. **RESOLVED 2026-09-04 (Mahi): start anyway.** Perfect
  ground truth is not available and waiting for reply data means waiting months
  to measure anything at all. His judgment is the best signal available today.
  Loop 2 corrects it when outcomes accumulate, which is why §2.4 ships in this
  sprint rather than later, and why the tune/held-out split exists — it at least
  prevents fitting the labels rather than the job.

### 7.11 Net v2.0 changes

| Finding | Section | Change |
|---|---|---|
| 2.a | §2.1, §2.3 | Datasets need a Mastra instance + storage adapter. Decide: stand up LibSQL, or keep cases in our store and use only `createScorer`. Default to the latter — fewer moving parts, one database |
| 2.c | §2.2 | Add a trajectory scorer. It grades the tool sequence, which is what the raw-vs-wrapped finding was about |
| 2.d | §2.3 | Use `collectToolMocks` so evals replay recorded output — no Apify cost, immune to the outage that ruined today |
| 3.a / 7.a | §2.4 | One state authority. `jobs.state` stops at `queued`; `sent` leaves the enum |
| 1.a | §2.1 | Store company name as well as URL; match on either |
| 1.b | §2.1 | Allow several acceptable contacts per case |
| 4.a | §2.1, §2.4 | Gitignore `data/cases/`; note third-party personal data in the schema |
| 6.b | §2.3 | If LibSQL lands, separate file, and state that eval state is disposable |
| 8.b | §3 | Test that `uncheckable` scores as no-score, never zero |

---

## 8. v2.1 10-dimension stress-test absorption notes

All 10 walked against the amended §2.3 and the plan as it now stands. 27
findings, 12 actionable. Three change the plan materially and are listed first
in §8.12.

### 8.1 Coverage gap rationale

v2.0 walked all 10, so there is no dimension debt to repay. What v2.0 did *not*
do is verify the APIs it named — every §2.3 claim was asserted, none checked.
That is a #2 failure, and it is why v2.0's §2.3 could not have been built as
written. This pass reads the installed packages rather than the plan's claims.

### 8.2 #1 Edge cases (4 findings, 3 actionable)

- 1.a: `runEvals` takes `concurrency`, defaulting to 1. Raising it for speed
  risks reproducing a recorded harness fault — a 13k prompt into a 4k window
  across four parallel slots produced zero tool calls in 308s and was reported
  as a model failure. **ACTIONABLE §2.3** — pin `concurrency: 1` for ollama and
  say why in the code.
- 1.b: a run that throws (`ActorBlockedError` on an exhausted Apify tier) is not
  a score of zero. `runEvals` wraps each gate in try/catch and pushes `0` on
  throw (`warnGateFailure`). A quota message therefore becomes a model failure —
  the exact class of error this project has lost the most time to.
  **ACTIONABLE §2.3**, and recorded there as the section's most important
  requirement.
- 1.c: zero graded cases, or fewer than `validateCases()` accepts. The runner
  must refuse with a reason rather than print an empty table. **ACTIONABLE §2.3.**
- 1.d: a provider named on the CLI but not configured (`cerebras` with no key)
  must fail that cell, not the whole matrix. **ACTIONABLE §2.3.**

### 8.3 #2 Unverified assumptions (6 findings, 4 actionable)

The dimension that carried this amendment. Every item below was checked against
the installed packages by importing them, not by reading documentation.

- 2.a **CORRECTED**: v2.0 §2.3 specified `dataset.startExperiment()`. **No such
  export exists** at `@mastra/core` 1.64.0 or `@mastra/evals` 1.10.0 — no
  `dataset`, no `Dataset`, no `startExperiment` on any probed entry point. v2.0
  §2.3 was unbuildable as written. **ACTIONABLE §2.3** — done, rewritten.
- 2.b **VERIFIED, and it dissolves the contradiction**: `runEvals` *does* exist,
  in `@mastra/core/evals`, as
  `runEvals({ data, scorers, gates, target, targetOptions, onItemComplete, concurrency })`.
  `data` is a plain array iterated with `pMap` — no Dataset required. Keeping
  cases in our own store and using Mastra's runner were never alternatives.
  **ACTIONABLE §2.3** — done.
- 2.c **VERIFIED**: storage is optional throughout —
  `target.getMastraInstance?.() || target.mastra`, then `mastra?.getStorage()`,
  and every persist is guarded `if (storage)`. Findings 2.a and 6.b of v2.0
  (no LibSQL, one database) hold, now on evidence rather than preference.
  (no action — recorded in §2.3.)
- 2.d **VERIFIED, path corrected**: `collectToolMocks` exists, but in
  `@mastra/core/evals`, not `@mastra/evals/scorers/utils` where v2.0's finding
  2.d implied it sat. **ACTIONABLE §2.3** — done.
- 2.e **[Mahi-verify] at build time**: trajectory-type *gates* resolve through
  `resolveTrajectory(storage, ...)`, and `runScorers` also receives `storage`.
  Our trajectory scorer sits in `SCORERS`, not `GATES`, so it is probably
  unaffected — but "probably" is what this dimension exists to catch. If
  trajectory scoring turns out to require storage, that is the single legitimate
  reason to stand up LibSQL, and it reopens finding 2.a. Verify before wiring.
- 2.f: `docs/architecture.md` draws `runEvals(target, data)` — two positional
  arguments. The real signature is one config object. Directionally right,
  literally wrong, and it is the doc a reader trusts. **ACTIONABLE** — correct
  it in the §2.3 build commit, not here.

### 8.4 #3 Actual code checks (6 findings, 1 actionable)

Every claim below verified by reading the file, per the anti-pattern about
config-level spot-checks.

- 3.a ✓ VERIFIED: `src/eval/scorers/index.ts:284-295` already exports
  `GATES = [noFabrication, grounded]`, `SCORERS = [answered, rightContact]` and
  `HARNESS_SCORERS = [evidenceUsable]` — the exact shape `runEvals` consumes.
  §2.2 built them compatible with a runner nobody had wired.
- 3.b ✓ VERIFIED: `loadCases()`, `saveCases()`, `validateCases()` and
  `CASES_PATH` all exist in `src/eval/cases.ts`. `CASES_PATH` defaults to
  `data/cases/cases.json`, overridable by `JOB_AGENT_CASES`.
- 3.c ✓ VERIFIED, and it is the blocker: **`data/cases/` does not exist.** Zero
  graded cases. Nothing in §2.3 can produce a number until §2.1 is done.
- 3.d ✓ VERIFIED: `src/agent/run.ts:106` `runOne(job, provider)` drives
  `agent.generate(enrichGoal(job), { maxSteps })` and returns a `RunRecord`. It
  is the basis for a `runEvals` target but is not shaped as one today.
- 3.e ✓ VERIFIED: `ProviderName = 'anthropic' | 'ollama' | 'cerebras'`
  (`src/ai/index.ts:16`), so §5's `--providers anthropic,cerebras` is valid.
- 3.f: `rightPerson(model)` (`src/eval/scorers/judged.ts:90`) is a factory, not
  a scorer instance, and `judgeContext(c)` is the only path a case reaches it by.
  The runner must construct it rather than import it. **ACTIONABLE §2.3** —
  recorded, and it is what keeps the judge blind.

### 8.5 #4 Security (4 findings, 1 actionable)

- 4.a ✓ VERIFIED: `.gitignore:23` is `data/`, so `data/cases/` is covered. Cases
  carry third-party personal data — real names and profile URLs of people who
  did not consent.
- 4.b: replay fixtures produced by `collectToolMocks` contain the same personal
  data as the runs they record. **ACTIONABLE §2.3** — they live under `data/`,
  never in the repo, never exported, and the plan says so rather than assuming
  a reader infers it.
- 4.c ✓ VERIFIED: no new dependency. `@mastra/core` is already present and
  already imported by the scorers. No `npm audit` surface change.
- 4.d ✓ VERIFIED: no secret reaches the experiment output. Provider selection is
  by name; keys stay in env and are never part of a result row.

### 8.6 #5 Vision alignment (3 findings, 0 actionable)

- 5.a ✓ ALIGNED: §2.3 is the only thing that answers the question `vision.md`
  calls the bet worth testing — whether a small model can do this judgement —
  and whose stated unacceptable outcome is not knowing.
- 5.b ✓ ALIGNED: no send path. The runner reads cases and drives the enrich
  agent; the terminal state is untouched.
- 5.c ✓ ALIGNED: replay means a graded run costs no Apify spend after the first
  recording, which honours "cost is visible before it is spent".

### 8.7 #6 Architecture consistency (4 findings, 1 actionable)

- 6.a ✓ ALIGNED: `src/eval/experiment.ts` sits beside `cases.ts` and `scorers/`,
  matching its sister modules.
- 6.b ✓ RESOLVED: v2.0 finding 6.b said "if LibSQL lands, separate file". It
  does not land. Verified at 2.c.
- 6.c ✓ ALIGNED: `CLAUDE.md` says `poll.ts` is the only orchestrator and
  everything else is a library it calls. `experiment.ts` is a CLI driver like
  `roles.ts` and `agent/run.ts`, not a second orchestrator of the poll path.
- 6.d: `runOne()` in `agent/run.ts` and the §2.3 target will both construct the
  enrich agent. Duplicating that is a DRY violation on the most load-bearing
  object in the system. **ACTIONABLE §2.3** — extract one driver, and let
  `npm run agent` and the experiment share it.

### 8.8 #7 Impact on other features (4 findings, 1 actionable)

**State-machine sub-analysis: NOT TRIGGERED.** §2.3 adds no state, increases
traffic into no state, and writes no `jobs.state`. §2.4 does all three — it
retires `sent` from the enum — and gets its own triggered pass in its own
session. Documented here so the skip is deliberate rather than forgotten.

- 7.a ✓ VERIFIED: no `jobs.state` write in §2.3.
- 7.b: `npm run agent -- <id>` shares the agent construction that 6.d proposes
  refactoring. That is the regression surface of this sprint step.
  **ACTIONABLE §2.3** — the extraction lands with tests, not after them.
- 7.c ✓ VERIFIED against `package.json`: an `experiment` script collides with
  nothing (`poll`, `poll:once`, `queue`, `cases:prepare`, `cases:check`,
  `agent`, `status`, `explain`, `sources`, `connections`, `test`, `typecheck`,
  `roles`).
- 7.d ✓ VERIFIED: `prepare-cases.ts` spends, and stays an approval-gated act.
  §2.3 itself spends nothing once replay exists.

### 8.9 #8 Test coverage (3 findings, 1 actionable)

- 8.a: §3 claimed a baseline of 29. Actual is **212**. **ACTIONABLE §3** — done.
- 8.b: the runner's own tests must not call a model. Aggregation, variance
  arithmetic, the unscoreable path and refusal-on-empty-case-set are all
  testable against fixtures. **ACTIONABLE §2.3** — spelled out at build time.
- 8.c ✓ VERIFIED: the `npm test` glob is still quoted
  (`node --import tsx --test 'src/**/*.test.ts'`). Any test nested two levels
  deep — which is where the scorer tests live — only runs because of it.

### 8.10 #9 Deployment & rollback (2 findings, 0 actionable)

- 9.a ✓ no deployment surface. This is a branch, a review and a merge. §2.3
  changes no schema, so rollback is reverting the commit.
- 9.b: §2.4 adds an `outcomes` table and changes `JOB_STATES`, which does have a
  rollback story. Verified today that `sent`, `enriched` and `queued` hold
  **zero rows**, so that migration is additive against live data — but it
  belongs to §2.4's own pass, not this one.

### 8.11 #10 Risks (4 findings, 2 actionable)

- 10.a: `runEvals` is Mastra's, so its behaviour can change under us on upgrade.
  Accepted, and preferred to the alternative: two of the day's six harness bugs
  in September came from reverse-engineering Mastra's internals rather than
  consuming its output. Mitigation is pinned versions, which `package.json`
  already does.
- 10.b: **the highest risk in this sprint is a harness fault scored as a model
  failure**, and `runEvals`' default gate handler does exactly that (1.b).
  Blast radius: a wrong answer to the only question the sprint exists to ask.
  **ACTIONABLE §2.3**, highest priority within it.
- 10.c: ten cases is small. Inherited from v2.0 §6 and still accepted — it
  catches large regressions and misses subtle ones, and growing it is cheap once
  the runner exists.
- 10.d **[Mahi-verify]**: the three §2.2 deviations remain unratified. §2.3
  wires `GATES` and `SCORERS` in the shape deviation (2) created, so a rejection
  changes §2.3. **Blocks locking this plan**, not drafting it.

### 8.12 Net v2.1 changes

| Finding | Plan section updated | Change |
|---|---|---|
| 2.a / 2.b | §2.3 | `dataset.startExperiment()` does not exist; `runEvals` does, and takes a plain array. Section rewritten around it |
| 1.b / 10.b | §2.3 | Unscoreable must not be scored as zero — named as the section's most important requirement, against Mastra's default |
| 4 (seq) | §4 | §2.4 now precedes §2.3 per Mahi; the unrecorded reorder across PRs #9-#14 is written down |
| 2.c | §2.3 | Storage optional, verified — no LibSQL, one database, upholding v2.0 finding 2.a |
| 2.d | §2.3 | `collectToolMocks` import path corrected to `@mastra/core/evals` |
| 1.a | §2.3 | `concurrency` pinned to 1 for ollama, with the reason |
| 1.c / 1.d | §2.3 | Refuse an ungradeable case set or an unconfigured provider, with a reason |
| 3.f | §2.3 | `rightPerson` is a factory; runner constructs it, judge stays blind |
| 6.d / 7.b | §2.3 | Extract one agent driver shared by `npm run agent` and the experiment |
| 4.b | §2.3 | Replay fixtures carry personal data; live under `data/`, never exported |
| 8.a | §3 | Test baseline 29 → 212 |
| 2.e / 10.d | — | `[Mahi-verify]`: trajectory-and-storage at build time; the three §2.2 deviations before this plan locks |

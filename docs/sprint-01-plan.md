# Sprint 1 — the evaluation harness

*v2.0. Supersedes v1.0, which was written before the Mastra refactor and before
seven harness faults showed that measurement, not capability, was the blocker.
Stress-tested across all 10 dimensions per `sop/stress-test-10-dimensions.md`;
absorption notes in §7.*

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

`src/eval/experiment.ts` wrapping `dataset.startExperiment()`. Runs
cases × providers, persists results, prints a table.

Must report **variance, not just means**. Claude picked Tiffany on one run and
Ingmar on two others from identical input. A single run per cell would report
that as a difference between models. Three runs per cell minimum.

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

Baseline **29**; target **~50**.

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

1. `git checkout -b feat/eval-harness`
2. §2.5 fixes — small, and they change what every later run reports
3. §2.1 `prepare-cases.ts`, hand the sheet to Mahi
4. §2.2 scorers while the sheet is being filled
5. §2.3 experiment runner
6. §2.4 outcome capture
7. `npm test`, `npm run typecheck`, journal in the same commit, push

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

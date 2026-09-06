# CLAUDE.md

Guidance for Claude Code working in this repository.

## Commands

```bash
npm install
npm run sources          # probe every configured board, no spend
npm run connections      # probe every MCP server, no spend
npm run poll -- --once   # one ingest + screen pass, then exit
npm run poll             # the loop
npm run status           # states, rejection reasons, spend
npm run queue            # today's outreach list
npm run queue -- --sent <id>      # and --accepted --replied --declined
npm run repair           # DRY RUN: the two one-shot live-data repairs
npm run explain -- <id>  # why one posting was skipped, or never seen
npm run agent -- <id>    # find the contact for one posting (SPENDS)
npm run cases:prepare    # build the eval grading sheet (SPENDS)
npm run cases:check      # validate the graded case set
npm run roles            # the roles, and which listings sit under each
npm run roles -- --taxonomy   # DRY RUN: what brands each company runs
npm run roles -- --learn      # derive and SAVE those taxonomies (SPENDS)
npm run roles -- --backfill   # regroup existing postings, no spend
npm test
npm run typecheck
```

**There is no `build` script.** `tsx` runs TypeScript directly; `npm run
typecheck` is the equivalent gate and must pass before a commit.

Run one test file, or one test:

```bash
node --import tsx --test src/screen/gates.test.ts
node --import tsx --test --test-name-pattern "location" src/screen/gates.test.ts
```

**The test glob must stay quoted.** `npm test` runs
`node --import tsx --test 'src/**/*.test.ts'`. Unquoted, the shell expands it
one directory deep and every test under `src/eval/scorers/` silently never
runs — which is exactly what happened until 2026-09-04. Quoted, Node does the
globbing and recurses.

## Architecture

`src/poll.ts` is the only orchestrator; everything else is a library it calls.
Reading it top to bottom explains the system.

- **`src/sources/`** — the only code that talks to the outside world. Every
  adapter normalises to one `JobPosting` shape so nothing downstream learns
  which board a posting came from. `Source.paid` tells the orchestrator to put
  cost behind the gates.
- **`src/screen/gates.ts`** — hard filters, pure functions. `passed()` is an
  AND. Each gate states whether a missing field is a rejection or a pass, and
  why; the two are not the same and the distinction is per-gate.
- **`src/score/score.ts`** — pure ranking over what already qualified.
- **`src/store/db.ts`** — SQLite. Makes polling idempotent and records why
  every rejection happened, so `explain` can answer later. Schema and the state
  machine: [docs/database.md](docs/database.md).
- **`src/agent/`** — the enrichment agent: a Mastra `Agent` given a goal, five
  wrapped Apify tools and a budget. `tools/index.ts` is the whole tool surface;
  `apify.ts` is the single MCP client and the only one anything should open.
  `run.ts` is the CLI driver.
- **`src/roles/`** — postings become roles. `key.ts` is pure and builds the id
  `company::unit::roleCore`; `taxonomy.ts` is the one model call per company
  that decides what business units it runs.
- **`src/eval/`** — the case set and the scorers. Nothing here touches the
  network except `prepare-cases.ts`.

Full picture in [docs/architecture.md](docs/architecture.md).

## The rule that shapes the design

**Nothing in this repo contacts a person.** No send path, no LinkedIn write,
no application submission. The machine's last word is `scored`; everything
after contact is a human typing `npm run queue -- --sent <id>`, and lives in
`outcomes`. This is not a TODO — it is the reason the project is safe to run
unattended. Do not add a send step, and do not add a dependency that could
become one, without an explicit decision from Mahi recorded in the journal.

## Things that are load-bearing and easy to miss

**Wrap every tool; never expose raw MCP.** Measured: on Apify's raw surface
(*call actor → get datasetId → get-dataset-items*) `gpt-oss-120b` made eighteen
consecutive searches in twenty steps and never read a result. The same model on
wrapped tools finished in five calls. A 120B failed there, so a 4B has no
chance — if you add a source, add a tool, not a passthrough.

**Constrain what is irreversible; inform everything else.** Money and
fabrication are constrained in-band — the budget refuses a call before it
happens, and `record_contact` refuses a quote it cannot find in tool output.
Everything else is the model's decision, including which source to try when one
returns nothing. An earlier version retried automatically; that was wrong,
because the right action is the same whether a source is empty or broken, so the
decision never needed the diagnosis. `actorHealth()` reports degradation to the
model rather than acting on it.

**An empty Apify result may be a plan limit wearing an empty result's
clothes.** The LinkedIn people-scrapers cap free-plan accounts, and a capped
run returns `status: SUCCEEDED`, zero rows, and `statusMessage: "free user run
limit exceeded"` — no error, 4.7s. Read as emptiness it becomes "this company
has nobody", and a day was lost calling it an upstream outage.
`runActorViaMcp` raises `ActorBlockedError` on it. Never add a code path that
treats zero rows as an answer without checking the run record first.

Two details that were got wrong once each: it is **per actor**, not account
wide — `harvestapi/linkedin-company` ran fine while both people-scrapers were
capped — and it is a **tier** check, not a balance one, so topping up credit
does not lift it. Wording also varies by actor ("reached" vs "exceeded"), which
is why `BLOCKING_STATUS` matches a pattern rather than a string.

**A role is not a posting, and the queue counts roles.** One job is advertised
many times — per market, per product line, and under different brands of the
same parent. 63 live postings are 21 roles. The extra listings sit in `variant`
and are shown under their role rather than competing for a queue slot.

**Exactly one posting per role is `scored`, and `src/roles/elect.ts` is the only
place that order is written down.** There used to be two copies — `roles.ts`
elected across every member, `poll.ts` across only the survivors of the current
pass — and since nothing in `poll.ts` demoted an incumbent, a role gained a
representative every pass in which it gained a posting. Measured on the same
store: the old code produced 9 `scored` rows across 7 roles, the new one 7.
Two copies of a rule is how they drift; do not write a third.

The order: contacted first (never demote work in hand), then freshest, then
best scored, then **the incumbent on a tie**, then lowest id. Incumbency is
there because `poll` can now demote — without it two tied postings swap the
slot every pass and the queue reshuffles daily for no visible reason. A
challenger takes the slot only by being strictly better.

**Grouping uses a model; screening does not.** Not a contradiction of the rule
above: screening runs over every posting ever seen and must stay free and
auditable, while grouping runs over the ~63 survivors and asks something no
rule can answer. The judgement is made **once per company** and cached in
`company_units`; `poll` only ever reads it, so an unattended run is never
blocked or billed by it.

**`jobs.state` is what the machine decided; `outcomes` is what happened with a
human.** One authority each, and they never share a column. `enriched`,
`queued` and `sent` used to be in `JOB_STATES` — the first two declared and
never written by anything, the third recording a human action in a machine's
enum. Both removed facts stay derivable: enrichment is a `contacts` row,
queued is `state = 'scored'` with no `outcomes` row. There is a test asserting
`JOB_STATES`, because nothing referenced those three in any test and that is
how two of them stayed dead for the life of the enum.

**Removing a state is only half-caught by the compiler.** `setState` is typed,
so call sites fail the build — but `queue.ts` and `roles.ts` carried states as
**SQL string literals**, which `tsc` cannot see. Grep the strings; do not trust
a green typecheck.

**Work already started outranks anything, and that fact lives in `outcomes`.**
`roles.ts` backfill never demotes a posting somebody has been contacted about,
because demoting it drops the role out of the queue while its outcome row hangs
off a posting nothing reads. This used to key on the `sent` state; deleting
that state without moving the rule would have removed the protection silently,
with no test failing.

**An unscoreable run is not a zero.** `src/eval/scorers/` throws
`UnscoreableRun` when evidence tools were called and returned nothing, rather
than scoring the model down. Seven "model failures" in one afternoon were all
harness faults; the instrumentation has been wrong more often than the models.
Preserve that distinction in anything new.

**Tests must not touch the real database.** ESM hoists `import` above
module-level code, so `process.env.JOB_AGENT_DB = ...` at the top of a test file
runs *after* `db.ts` opened the real one. It wrote 99 rows into production state
before it was caught. Assign the env var, then `await import()` the module.

## Cost

Only `src/sources/apify/` spends money. The ordering in `poll.ts` is the cost
model: free boards and one thin paid search produce candidates, the gates throw
most away for nothing, and only survivors reach paid enrichment.
`enrich.maxSpendPerDayUsd` is a hard daily ceiling checked against the `spend`
table before any paid source runs.

Hourly polling at breadth costs roughly $430/month and buys nothing — job
postings do not turn over hourly. The default is every 8 hours.

## Constraints

- **No personal data in this repo.** Corpus, CVs, database and queue live
  outside it. Check `.gitignore` before adding a path.
- Verify a board adapter against the live endpoint before trusting its shape.
  All three current adapters were verified on 2026-09-04; documentation and
  reality disagree often enough that this matters.
- Node 22+.

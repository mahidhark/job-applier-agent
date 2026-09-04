# CLAUDE.md

Guidance for Claude Code working in this repository.

## Commands

```bash
npm install
npm run sources          # probe every configured board, no spend
npm run poll -- --once   # one ingest + screen pass, then exit
npm run poll             # the loop
npm run status           # states, rejection reasons, spend
npm run queue            # today's outreach list
npm run explain -- <id>  # why one posting was skipped, or never seen
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
  every rejection happened, so `explain` can answer later.

## The rule that shapes the design

**Nothing in this repo contacts a person.** No send path, no LinkedIn write,
no application submission. The terminal state is `queued`; a human moves it to
`sent`. This is not a TODO — it is the reason the project is safe to run
unattended. Do not add a send step, and do not add a dependency that could
become one, without an explicit decision from Mahi recorded in the journal.

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

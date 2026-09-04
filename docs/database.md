# Database

One SQLite file. `src/store/db.ts` is the only code that touches it.

```
~/.job-applier-agent/agent.db      (DB_PATH, src/config.ts)
```

It lives **outside the repo** — it holds names, profile URLs and drafted notes
about people who did not consent to being in anybody's dataset. `data/` is
gitignored as a second line of defence. Override the path with
`JOB_AGENT_DB=/some/other.db`, which is how the tests avoid the real one.

WAL mode is on, so `npm run status` can read while `npm run poll` is writing.

## What it is for

The database is the memory that makes polling idempotent. Two jobs, and only
these two:

1. **A posting seen yesterday must not reappear in today's queue.**
2. **A posting we decided against must record WHY**, so `npm run explain <id>`
   can answer for it weeks later.

Everything else — scores, contacts, spend — exists to serve one of those.

## Tables

### `roles` — one row per job, however many times it is advertised

| column | type | note |
|---|---|---|
| `id` | TEXT PK | `company::unit::role core`, and the key itself |
| `company` | TEXT | as the board wrote it |
| `role_key` | TEXT | same as `id`; kept for readability in queries |
| `title` | TEXT | the role core, e.g. `Technical Product Lead` |
| `unit` | TEXT | which business unit, e.g. `kira`. `default` when a company has one |
| `first_seen` | TEXT | ISO |

**A role is a job at a business unit, not a posting.** Bjak advertises one
Technical Product Lead opening as eight rows differing only by product line,
and does it under two brands. Postings point at a role through `jobs.role_id`;
one of them is the representative and the rest sit in `variant`.

The id is the key, so recording the same role twice is a no-op rather than a
second row — which is what makes the backfill safe to re-run.

Every segment is slugified (`slugSegment` in `src/roles/key.ts`), because a
company or brand called `A::B` would otherwise corrupt the id.

### `company_units` — what brands a company runs

| column | type | note |
|---|---|---|
| `company`, `slug` | TEXT | composite PK. Company is lowercased |
| `name` | TEXT | the display name. `KIRA`, never `kira` |
| `description` | TEXT | what this unit is |
| `evidence` | TEXT | text from a real posting proving it exists |
| `qualifiers` | TEXT | JSON array of the title qualifiers assigned here |
| `decided_at` | TEXT | ISO |

Derived **once per company** by a model, because which brands a company runs is
a fact about the company. Deriving it per candidate group produced six
independent answers for Bjak that disagreed with each other.

`evidence` is required so an invented unit has to quote something. Bjak's two
units cite `"ABOUT BJAK The original mission..."` and `"About KIRA Our mission
is to make money smart..."` — the literal boilerplate paragraphs.

**Writes are additive.** A unit already recorded keeps its name and gains new
qualifiers; nothing is renamed. Re-deriving because one unseen qualifier turned
up must not rename a unit that roles already point at.

`npm run roles -- --learn` derives and saves. `--taxonomy` shows what it would
say without writing. The poll only ever **reads** this table, so an unattended
run can neither be blocked nor billed by it.

### `decisions` — every judgement, and what Mahi said it should have been

| column | type | note |
|---|---|---|
| `id` | TEXT PK | |
| `kind` | TEXT | `group` \| `contact` \| `screen` \| `draft` \| `taxonomy` |
| `subject` | TEXT | role id, job id, or company |
| `context`, `chose` | TEXT | JSON: what it saw, what it decided |
| `reasoning` | TEXT | why, in its own words |
| `decider` | TEXT | the model id, or `key` when it fell back |
| `corrected_at`, `corrected_to`, `correction_note` | TEXT | null until Mahi disagrees |

**The substrate under every way this system can improve.** Few-shot needs
examples, retrieval needs stored decisions, LoRA needs graded pairs, DPO needs
chosen-against-rejected — all four are these rows. Nothing was recorded before
this table, so no path was open at all.

`correction_note` is the valuable column. *"Homedeal and Moving24 are separate
brands"* generalises to every multi-brand parent; the corrected partition
generalises to nothing.

Not merged with `gates`, though both record why something happened. A gate row
is per-posting per-rule and deterministic; a decision is one judgement, made by
a model, that a human may overrule.

### `jobs` — one row per posting ever seen

| column | type | note |
|---|---|---|
| `id` | TEXT PK | `<source>:<their id>`, e.g. `greenhouse:4917716101` |
| `source` | TEXT | which adapter produced it |
| `title`, `company`, `location`, `url` | TEXT | normalised `JobPosting` fields |
| `posted_at` | TEXT | ISO. Null when the board does not say |
| `first_seen`, `last_seen` | TEXT | ISO. `last_seen` moves on every poll |
| `state` | TEXT | see the state machine below |
| `score` | REAL | null until it clears the gates |
| `role_id` | TEXT | which role this advertises. Null until grouping runs |
| `raw` | TEXT | the whole original posting as JSON |

`raw` is kept deliberately. Every gate bug so far was found by re-reading the
original posting against the decision, and a normalised row throws away the
field that turns out to matter.

Indexed on `state` and `first_seen` — the two things `status` and `queue` scan.

### `gates` — why a posting was rejected

| column | type | note |
|---|---|---|
| `job_id`, `gate` | TEXT | composite PK: one verdict per gate per job |
| `passed` | INTEGER | 0/1 |
| `detail` | TEXT | the human-readable reason, e.g. `Sydney, AU` |
| `checked_at` | TEXT | ISO |

**Every gate records a row, passing ones included.** A rejection reason on its
own tells you which gate fired; the full set tells you how close a posting came,
which is what makes a threshold argument settleable.

`detail` is the field that matters. A gate counter says `location_eligible`
fired 287 times; the newest `detail` says it was rejecting Sydney duplicates of
a Netherlands role, which is a different bug entirely.

### `contacts` — who the agent found

| column | type | note |
|---|---|---|
| `job_id`, `profile_url` | TEXT | composite PK |
| `name`, `title` | TEXT | as their profile states it |
| `source` | TEXT | which tool or actor produced it |
| `context` | TEXT | the grounded observation, or null |
| `found_at` | TEXT | ISO |
| `role_id` | TEXT | the role, not just the posting. Filled by the backfill |

`context` is only ever written when `record_contact`'s grounding check passed,
so a row here carries a claim the tools actually supported. It is not scored
afterwards — it is grounded by construction or it is null.

### `drafts` — the outreach note

| column | type | note |
|---|---|---|
| `job_id`, `kind` | TEXT | composite PK; `kind` distinguishes note from message |
| `body` | TEXT | the text a human will send |
| `created_at` | TEXT | ISO |

### `spend` — every paid call, append-only

| column | type | note |
|---|---|---|
| `at` | TEXT | ISO |
| `actor` | TEXT | the Apify actor |
| `usd` | REAL | the declared price of that tool |
| `note` | TEXT | free text |

`spentLast24h()` sums a rolling window, checked against
`enrich.maxSpendPerDayUsd` **before** a paid source runs. Append-only because a
ceiling you can edit is not a ceiling.

### `actor_calls` — did the source actually answer?

| column | type | note |
|---|---|---|
| `at` | TEXT | ISO |
| `actor` | TEXT | the Apify actor |
| `rows` | INTEGER | how many records came back |
| `errored` | INTEGER | 0/1 |

Separate from `spend` because they answer different questions: `spend` asks what
it cost, `actor_calls` asks whether it worked.

`actorHealth(hours = 6)` calls an actor **degraded** when it has been called at
least three times in the window and every non-errored call returned zero rows.
Three, not one: an empty result is a legitimate answer, and a company can
genuinely have nobody findable.

This exists because on 2026-09-04 `linkedin-profile-search` returned zero rows
for every company including Booking.com, having worked three hours earlier.
That was diagnosed as an upstream outage; it was almost certainly an exhausted
Apify quota, which returns `SUCCEEDED` with zero rows and the reason in a
`statusMessage` field nothing read. `runActorViaMcp` now raises on that
directly, so this table is a second line of evidence rather than the first.

The degradation verdict is **reported to the model, not acted on** — the tool
says an empty result is ambiguous and names the other source. The model
decides.

## The state machine

`JOB_STATES` declares eight states. **Only six are ever written**, and knowing
which is the difference between working code and a query that silently matches
nothing.

```
                    ┌───────────────► rejected        poll.ts:63, a gate said no
                    │
  seen ─────────────┼───────────────► skipped         poll.ts:82, duplicate of a
  poll.ts:55        │                                 posting already kept
                    │
                    ├───────────────► variant          another listing of a
                    │                                   role already kept
                    │
                    └───────────────► scored ─────────┐  poll.ts:89
                                                      │
                                        the agent runs here and writes
                                        contacts + drafts, NOT a state
                                                      │
                                        ┌─────────────┴─────────────┐
                                        ▼                           ▼
                                      sent                       skipped
                              queue.ts:27, a human        queue.ts:32, a human
```

**`variant` is not a rejection.** It means "we already kept this job under
another listing". It is deliberately *not* `skipped`, which already carried two
unrelated meanings — a duplicate the machine dropped, and a role Mahi does not
want. Grouping would have drowned the second in the first and made the count in
`npm run status` meaningless. A current store reads `12 scored, 26 variant, 12
skipped`, and all three numbers mean something.

**`enriched` and `queued` are declared and never written.** Nothing sets them.
`queue.ts` selects `state IN ('scored','enriched','queued')` and works only
because of the first of those. Do not write logic that waits on either without
setting it first — this is the same trap the Upwork agent has with `screened`
and `drafted`, and it is worth checking before assuming a state exists.

**The last state this repo writes is `scored`.** Nothing here writes `sent`;
a human does, with `npm run queue -- --sent <id>`. That is not a TODO — it is
the reason the project is safe to run unattended.

Two more things before writing logic against a state:

- **Nothing sweeps `scored` later.** The enrichment agent runs in the same pass
  that scored the posting. A job that reaches `scored` and is not enriched then
  is stranded until you run `npm run agent -- <id>` against it by hand.
- **There is one `scored` posting per role, not per job.** The queue shows 12
  entries for 38 live postings, and the other 26 are listed underneath the role
  they belong to rather than competing for a slot.
- **The state is a decision record, not a work queue.** `last_seen` moving does
  not re-open a decision. A posting rejected on Monday stays rejected on
  Tuesday even though the poll saw it again, which is the whole point of (1)
  above.

## What is deliberately NOT in here

**Company taxonomies are IN here, deliberately.** They are a judgement about a
real employer that many roles depend on, they are corrected by hand, and losing
them would silently regroup every role. That is operational state, not eval
state.

**The eval case set.** `data/cases/cases.json`, a plain JSON file outside git.
It is graded by hand, versioned by copying, and read only by `src/eval/`. It
does not belong in the operational database for two reasons: it is third-party
personal data with a different retention story, and eval state is disposable
while `jobs` is not. Deleting the case set costs an afternoon of grading;
deleting `jobs` loses every rejection reason ever recorded.

**Eval results.** Scores live wherever §2.3's runner puts them, and if that
turns out to be LibSQL it gets its own file. Mixing a disposable experiment log
into the store that makes polling idempotent is how you end up afraid to clear
either.

## Working with it

Prefer the commands over opening the file:

```bash
npm run status              # states, rejection reasons by gate, spend
npm run queue               # what is waiting for a human
npm run explain -- <id>     # every gate verdict for one posting
```

`q<T>(sql, ...params)` is the escape hatch for a one-off read. If you find
yourself writing the same query twice, it belongs in `db.ts` with a name.

**Tests must not touch the real database.** ESM hoists `import` above
module-level code, so setting `process.env.JOB_AGENT_DB` at the top of a test
file runs *after* `db.ts` has already opened the real one. This is not
theoretical — it wrote 99 rows into production state before it was caught. Any
test that touches the store must assign the env var and then `await import()`
the module.

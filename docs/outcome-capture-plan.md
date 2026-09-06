# Plan v1.0 — outcome capture: the system learns what happened after you hit send

*Sprint 1 §2.4, expanded. Stress-tested across all 10 dimensions per
`sop/stress-test-10-dimensions.md`; absorption notes in §9. Draft — not
ratified.*

## 1. What this is for

The loop is open. The system finds a role, finds a person, puts them in the
queue — and then goes blind. You send a connection request, they accept or
ignore it, they reply or they do not, and none of that ever comes back.
`npm run queue -- --sent <id>` marks the row and forgets.

Three things follow from that, and all three are why this ships before §2.3.

**Nothing knows whether the system works.** The whole thesis is that outreach
converts near 50% and forms near 3%. Nothing measures whether *this system's*
picks land anywhere near that. It could be choosing the wrong person every time
and would look identical from outside.

**The only judge of "right person" is Mahi's opinion.** That is the best signal
available today and it is not ground truth. A reply is ground truth. The eval
case set is explicitly built on his judgement with a note saying real outcomes
correct it later (`sprint-01-plan.md` §6). This is later.

**The evidence is being destroyed daily.** A reply received last week and not
recorded is gone. Every other item on the roadmap costs the same in a month;
this one gets more expensive every day, and there are already contacts out in
the world.

After this, `npm run status` can say something it physically cannot say today:
*of the 20 people this system picked, 11 accepted and 4 replied.* That is the
first honest scoreboard the project has had.

## 2. The shape

### 2.1 One authority each

The change that makes the rest coherent:

```
  jobs.state   what the MACHINE decided     seen · rejected · scored · skipped · variant
  outcomes     what happened with a HUMAN   sent · accepted · replied · declined
```

`enriched` and `queued` are removed from `JOB_STATES`. They have been declared
and never written since the enum shipped — `CLAUDE.md` already carries the
warning — and §2.4's original wording, *"`jobs.state` stops at `queued`"*, cannot
be true of a state nothing sets. `sent` moves out of the enum entirely, because
"I contacted this person" is not something the machine decided.

Both facts stay derivable, so nothing is lost:

- enrichment → a `contacts` row exists for that `job_id`
- queued → `state = 'scored'` and no `outcomes` row

**Ratified 2026-09-06.** This deviates from §2.4 as written; recorded here so
the deviation is visible rather than inferred.

### 2.2 The outcomes table

```sql
CREATE TABLE IF NOT EXISTS outcomes (
  job_id       TEXT NOT NULL,
  contact_url  TEXT NOT NULL DEFAULT '',
  channel      TEXT NOT NULL,
  sent_at      TEXT,
  accepted_at  TEXT,
  replied_at   TEXT,
  outcome      TEXT,
  note         TEXT,
  PRIMARY KEY (job_id, contact_url)
);
```

Five decisions inside that, each of which the stress test forced:

**Keyed on `(job_id, contact_url)`, not on `contact_url`.** The same person can
own two roles you pursue. Keying on the person alone would make the second
outreach overwrite the first (#1.g).

**`contact_url` defaults to `''` rather than being nullable.** SQLite does not
enforce uniqueness across NULLs, so a nullable key column would let the same
job accumulate unlimited duplicate outcome rows. The empty string is the "I
found this person myself, outside the system" case, and it stays unique per job
(#1.d).

**Every timestamp is nullable, and the sequence is not enforced.** A reply can
arrive for a message sent outside the system, and refusing to record it would
discard ground truth to protect a schema (#1.a).

**Timestamps are never overwritten.** The first acceptance is the real one;
marking twice is a no-op on the existing value, not a refresh (#1.b).

**Keyed on `job_id`, never on state.** A posting that represented its role when
you messaged it can be demoted to `variant` by a later regroup. The outcome must
survive that (#1.e).

### 2.3 The flags

```
  BEFORE CONTACT  (a state)
    npm run queue -- --skip <id>        I do not want this role

  AFTER CONTACT   (an outcome)
    npm run queue -- --sent <id>        I sent it
    npm run queue -- --accepted <id>    they accepted
    npm run queue -- --replied <id>     they replied
    npm run queue -- --declined <id>    they said no

  no response = no row. Absence is the signal.
```

`--declined`, not `--rejected`. `--skip` and `--rejected` are opposite ends of
the funnel wearing the same word-shape, and once both exist they are confused
permanently. **Ratified 2026-09-06.**

An unknown `job_id` refuses rather than inserting an orphan row (#10.d).

### 2.4 What `status` reports

A new section, over a 30-day window (`at >= now - 30d`, inclusive at the
boundary — #1.f), modelled on the existing `spentLast24h`:

```
  OUTREACH, LAST 30 DAYS

    20  sent
    11  accepted        55%
     4  replied         20%
     2  declined        10%
```

With a zero denominator the rate prints `—`, never `0%` and never `NaN`
(#1.c). `0 sent` and `0 accepted` are the same number and mean opposite things.

## 3. The two live-data migrations

Both ratified 2026-09-06. Both are §3 stop-and-ask territory and both are
one-shot repairs, not code that runs again.

### 3.1 The 12 stranded rows

All 12 `skipped` rows are Bjak, Ashby, first seen 2026-09-04, score 0.0,
`role_id` NULL, and every one passed every gate. Each has a same-titled live
listing already inside a role. They are pre-`variant` machine dedupes from the
exact-title dedupe that grouping replaced. **None of them are Mahi's
rejections**, so `status` printing "12 skipped" is telling him he rejected
twelve roles he never saw.

Repair: set them to `variant`, **score them first**, then re-run backfill.

Scoring first is not tidiness. `roles.ts` backfill ranks representatives by
`posted_at` *before* score, so restoring an unscored 0.0 row could hand it a
representative slot ahead of a properly-scored sibling. Scoring is pure and free
(`scoreJob(job, now, config.score, config.screen)`), and each row's `JobPosting`
is already in `jobs.raw`.

The 12 ids go in the journal, so the change is reversible. Ids are not personal
data.

### 3.2 The contacts cleanup

`contacts` holds 5 rows. Three go:

| row | why |
|---|---|
| `test:1` / Pieter Westerhuis | `linkedin.com/in/example`, and **no `jobs` row exists for `test:1`** — residue of the ESM-hoisting incident that wrote 99 rows into the live database |
| Tiffany S. (second row) | `profile_url` is an opaque `ACwAAA…` member id — the Short-mode bug, a dead link. Her real row (`/in/tiffanysoto`) stays |
| Mark Feenstra | opaque member id, no title (the `headline` bug), no context. The row carries nothing actionable |

This is why `contacts` PK is `(job_id, profile_url)` and `recordContact` uses
`INSERT OR REPLACE`: one person under two URLs is two legal rows, which is
exactly how the Tiffany duplicate arose (#3.c).

It matters now rather than later because `outcomes.contact_url` joins to these.
A dead URL as an outcome key is a corrupted scoreboard on day one.

**The rows are printed to the terminal before deletion.** They are personal data
and cannot be copied into the repo as a backup, so the print is the record and
it is Mahi's to keep or discard (#4.d, #9.d).

## 4. Changes

| file | change |
|---|---|
| `src/store/db.ts` | `outcomes` table; `recordOutcome` / `outcomeFor` / `outcomeRates`; `JOB_STATES` loses `enriched`, `queued`, `sent` |
| `src/queue.ts` | `--sent` writes an outcome not a state; add `--accepted`, `--replied`, `--declined`; SELECT becomes `state = 'scored' AND id NOT IN (SELECT job_id FROM outcomes)` |
| `src/roles.ts` | backfill SELECT drops the dead states; the representative rank rule moves from `sent` to "has an outcome row" — see §9.8 finding 7.b |
| `src/status.ts` | the outreach section above |
| `src/store/outcomes.test.ts` | new, ~8 tests |
| `src/store/repair.ts` | the two one-shot migrations, `npm run repair -- --dry-run` by default |
| `CLAUDE.md` | the "`enriched` and `queued` are declared and never written" note is now false and must go in the same commit |
| `docs/sprint-01-plan.md` | §2.4 points here |

## 5. What this does not do

- **It does not make the agent smarter this week.** It starts the clock so that
  in a month there is something to be smart with.
- **It does not send anything.** Every flag records something a human already
  did. `vision.md` is unaffected.
- **It does not add the learning-loop writes.** `recordDecision` from the
  agent's `record_contact` / `record_no_contact`, and a correction path so
  `recordCorrection` stops being test-only, are the same surface and the same
  table and are genuinely tempting. They are §9.12, open for Mahi, and out of
  scope until he says otherwise.

## 6. Sequence

1. `git checkout -b feat/outcome-capture`
2. **Re-verify** that `sent`, `enriched` and `queued` still hold zero rows. The
   2026-09-06 reading is evidence about that day, not a licence (#2.b)
3. `outcomes` table + the three db functions, with tests
4. `JOB_STATES` change — and grep the **SQL string literals**, which the
   compiler cannot see (#2.a)
5. `roles.ts` rank rule moves from `sent` to outcome-existence (#7.b)
6. `queue.ts` flags; `status.ts` section
7. `src/store/repair.ts`, dry-run first, then the two migrations
8. `npm test`, `npm run typecheck`, `CLAUDE.md` and journal in the same commit

## 7. Done when

`npm run queue -- --sent <id>` then `--accepted <id>` writes one outcome row
with two timestamps and does not touch `jobs.state`; `npm run status` reports an
acceptance rate; `npm run status` reports **0 skipped**; `contacts` holds two
rows and both URLs open; and `npm run roles` shows the same representatives as
before the migration.

## 8. Risks accepted

- **The rates will be meaningless for weeks.** Two contacts and no outcomes is
  not a denominator. The number is worth having anyway because it can only be
  built forwards.
- **Outcomes are recorded by hand**, so they are as reliable as Mahi
  remembering to type them. No integration reads LinkedIn, and adding one would
  cross the line `vision.md` draws.
- **A reply is still a weak signal of "right person".** Someone can reply
  politely and not be the decision-maker. It is a far better signal than the
  alternative, which is nothing.

---

## 9. v1.0 10-dimension stress-test absorption notes

All 10 walked. 31 findings, 15 actionable. The #7 state-machine sub-analysis is
**triggered** and is where the most serious finding of this pass came from
(7.b); it is listed first in §9.11.

### 9.1 #1 Edge cases (7 findings, 7 actionable)

- 1.a: `--replied` with no prior `--sent`, because the message went out before
  this existed or outside the system. **ACTIONABLE §2.2** — every timestamp
  nullable, sequence not enforced. Refusing would discard ground truth to
  protect a schema.
- 1.b: `--accepted` twice. The second must not refresh the timestamp; the first
  acceptance is the real one. **ACTIONABLE §2.2** — write only when the column
  is NULL.
- 1.c: rate arithmetic with a zero denominator. `0 sent` and `0 accepted` are
  the same number meaning opposite things. **ACTIONABLE §2.4** — print `—`,
  never `0%`, never `NaN`.
- 1.d: an outcome against a job with no `contacts` row — the queue prints "no
  contact identified yet" and Mahi messages someone he found himself. Must be
  recordable. **ACTIONABLE §2.2** — `contact_url` defaults to `''` rather than
  NULL, because SQLite does not enforce uniqueness across NULLs and a nullable
  key column would let one job accumulate unlimited duplicate rows.
- 1.e: a posting that was its role's representative when contacted is demoted to
  `variant` by a later regroup. **ACTIONABLE §2.2** — outcomes key on `job_id`
  and never read state.
- 1.f: a row exactly 30 days old, and DST inside the window. **ACTIONABLE §2.4**
  — `>=` on an ISO timestamp, inclusive, stated in the code.
- 1.g: the same person for two different roles. **ACTIONABLE §2.2** — PK is
  `(job_id, contact_url)`; keying on the person alone would let the second
  outreach overwrite the first.

### 9.2 #2 Unverified assumptions (5 findings, 3 actionable)

- 2.a **PARTIALLY FALSE, and this is the trap**: the assumption that typecheck
  catches every use of a removed state. `setState = (id: string, state:
  JobState)` is typed, so call sites *are* caught — but `queue.ts:47` and
  `roles.ts:57` carry the states as **SQL string literals**, which the compiler
  cannot see. Removing them from the enum leaves those queries silently
  selecting on values that can no longer exist. **ACTIONABLE §6 step 4** — grep
  the strings; do not trust the build.
- 2.b **VERIFIED 2026-09-06, must be re-verified**: `sent`, `enriched` and
  `queued` all hold zero rows, so the enum change is additive against live data.
  That is a reading about one day. **ACTIONABLE §6 step 2.**
- 2.c ✓ VERIFIED: `db.ts:17-31` has `addColumn()` for post-ship columns and this
  repo has no migration runner. `outcomes` is a whole new table, so
  `CREATE TABLE IF NOT EXISTS` covers it and no `addColumn` call is needed.
- 2.d **FALSE**: the assumption that `recordContact` writes `role_id`. It writes
  seven columns and `role_id` is not among them — a contact gets one only when
  `roles.ts --backfill` remaps it. So a freshly found contact has a NULL
  `role_id`. Not blocking (outcomes key on `job_id`), but it means any future
  "outcomes per role" report cannot rely on `contacts.role_id` being populated.
- 2.e ✓ VERIFIED: `queue.ts:33` is the only writer of `skipped` anywhere in
  `src/`, which is what makes the §3.1 finding safe to act on.

### 9.3 #3 Actual code checks (6 findings, all verified)

- 3.a ✓ Exactly five non-test references to the three states:
  `queue.ts:28`, `queue.ts:47`, `roles.ts:57`, `roles.ts:98`, `roles.ts:115`,
  plus the enum at `db.ts:171`. **Zero test files** reference them.
- 3.b ✓ `setState` is `(id: string, state: JobState)` — typed, so call sites are
  compiler-visible. See 2.a for what is not.
- 3.c ✓ `contacts` PK is `(job_id, profile_url)` and `recordContact` uses
  `INSERT OR REPLACE`. One person under two URLs is two legal rows — which is
  precisely how the Tiffany duplicate arose, not a bug in the write path.
- 3.d ✓ `spentLast24h(kind?)` at `db.ts:460` is the working model for a windowed
  aggregate with a `COALESCE` default; `outcomeRates` follows its shape.
- 3.e ✓ `scoreJob(job, now, config.score, config.screen)` needs a `JobPosting`,
  and every stranded row has one in `jobs.raw`. The §3.1 repair is therefore
  possible without a network call.
- 3.f ✓ `decisions.test.ts` sets `JOB_AGENT_DB` and then `await import()`s the
  module, with the reason in a comment. `outcomes.test.ts` copies that exactly.

### 9.4 #4 Security (4 findings, 1 actionable)

- 4.a ✓ `outcomes.contact_url` is third-party personal data. The database
  already lives outside the repo (`~/.job-applier-agent/agent.db`, `config.ts:6`)
  and `.gitignore:23` covers `data/`. No new exposure surface.
- 4.b: `note` is free text. It is never exported and never logged beyond the
  terminal. (no action — same treatment as `decisions.correction_note`.)
- 4.c ✓ No new dependency; no `npm audit` delta.
- 4.d: the contacts deletion is irreversible and the rows cannot be backed up
  into the repo, because they name real people. **ACTIONABLE §3.2** — print the
  rows to the terminal before deleting. The print is the record, and it is
  Mahi's to keep.

### 9.5 #5 Vision alignment (3 findings, 1 actionable)

- 5.a ✓ ALIGNED: `vision.md` says the operator's judgement is spent on whether
  to send. Recording what happened after is the half that was missing, and the
  document's own "real outcomes correct it later" is this.
- 5.b ✓ ALIGNED: no send path. Every flag records something a human already did.
- 5.c: `vision.md` insists rejections stay explainable. A `--declined` with no
  note teaches nothing later, which is the same reasoning that made
  `correction_note` required-by-caller on `decisions`. **ACTIONABLE §2.3** —
  `--declined` prompts for a note; it does not refuse without one, because a
  refusal loses the fact to protect the annotation.

### 9.6 #6 Architecture consistency (4 findings, 1 actionable)

- 6.a ✓ `outcomes` lives in `db.ts` with every other table. No new store.
- 6.b ✓ The one-authority split (§2.1) is the point, and it resolves the
  contradiction §2.4 could not express while `queued` was a state nothing wrote.
- 6.c ✓ `queue.ts` is the only writer of outcomes, consistent with it being the
  human's surface. `poll.ts` remains the only orchestrator and never reads them.
- 6.d: `CLAUDE.md` documents "`enriched` and `queued` are declared in
  `JOB_STATES` and never written" as a thing to watch for. That becomes false
  with this change. **ACTIONABLE §4** — it goes in the same commit, per the
  documentation rule.

### 9.7 #7 Impact on other features — **STATE-MACHINE SUB-ANALYSIS TRIGGERED**

This change removes three states and adds a parallel record. Tabulating
producers × consumers × affordances, as required:

| state | producers | consumers | CLI affordance |
|---|---|---|---|
| `seen` | `upsertJob` | `poll` (skips if not new) | none |
| `rejected` | `poll.ts:86` | `status`, `explain` | none |
| `scored` | `poll.ts:166`, `roles.ts:114` | `queue.ts:47`, `roles.ts:57` | listed by `queue` |
| `variant` | `poll.ts:173`, `roles.ts:119` | `roles.ts:57`, `postingsInRole` | listed under its role |
| `skipped` | `queue.ts:33` | `status` counts | `--skip` |
| `enriched` | **NONE** | `queue.ts:47`, `roles.ts:57`, `roles.ts:98` | none |
| `queued` | **NONE** | `queue.ts:47`, `roles.ts:57`, `roles.ts:98` | none |
| `sent` | `queue.ts:28` | `roles.ts:98`, `roles.ts:115` | `--sent` |

- 7.a: `enriched` and `queued` have **consumers but no producers** — three
  SELECTs and a rank function branch on values nothing can write. The parity
  failure is pre-existing and removing the states is the fix, provided the SQL
  strings go too (2.a). **ACTIONABLE §6 step 4.**
- 7.b **THE FINDING OF THIS PASS.** `roles.ts:98` ranks representatives
  `sent → 0, queued → 1, enriched → 2, else 3`, and `roles.ts:115` refuses to
  demote a `sent` row. The comment states the rule: *"work already started
  outranks anything: a posting that has been queued or sent is the one the
  operator has in hand, and demoting it would orphan that work."* Deleting
  `sent` from the enum **deletes that protection**, and nothing in §2.4 as
  written replaces it. A posting Mahi has already messaged could then be
  demoted to `variant` by the next regroup and vanish from the queue, with the
  outcome row still attached to a posting nobody looks at. **ACTIONABLE §4 and
  §6 step 5** — the rank rule moves to outcome-existence: a job with an
  `outcomes` row outranks one without, and is never demoted. This is a silent
  no-op of exactly the shape the sub-analysis exists to catch.
- 7.c ✓ PARITY OK: `--skip` writes `skipped`; `queue.ts`'s SELECT excludes it;
  nothing offers an action on a `skipped` row. Offered and performed match.
- 7.d ✓ PARITY OK after the change: the new SELECT is
  `state = 'scored' AND id NOT IN (SELECT job_id FROM outcomes)`. A contacted
  posting leaves the queue by acquiring an outcome, not by changing state, and
  a skipped one stays out because its state is not `scored`.
- 7.e: `status.ts` counts states, so "12 skipped" becomes "0 skipped" after
  §3.1. That is the intended correction, not a regression, but it will look
  like data loss if it is not written down. **ACTIONABLE §3.1** — the journal
  records the before and after counts.

### 9.8 #8 Test coverage (4 findings, 3 actionable)

- 8.a: baseline **212**; target **~220**. **ACTIONABLE §4.**
- 8.b: `outcomes.test.ts` must set `JOB_AGENT_DB` and then `await import()` the
  module. Getting this wrong once wrote 99 rows into the live database.
  **ACTIONABLE** — copy `decisions.test.ts:1-18` exactly.
- 8.c ✓ VERIFIED and uncomfortable: **no test anywhere references `sent`,
  `queued` or `enriched`.** Removing them breaks nothing, which means nothing is
  protecting the behaviour either. **ACTIONABLE** — add a test asserting
  `JOB_STATES` contents, so a future re-addition is a deliberate act.
- 8.d: the §3 migrations are one-shot, so the test covers the *logic* against a
  temp database, never the live one. `--dry-run` is the default.

### 9.9 #9 Deployment & rollback (4 findings, 2 actionable)

- 9.a ✓ No deployment surface. Local SQLite, one machine.
- 9.b: **back up the database before either migration.** `cp` of the `.db` file
  copies no bytes into the session, but if the permission layer refuses it, it
  is Mahi's command to run. **ACTIONABLE §6 step 7** — the repair refuses to run
  unless a backup path is given or `--force` is passed.
- 9.c: rollback for §3.1 is by id — the 12 are named in the journal, and ids are
  not personal data. **ACTIONABLE §3.1.**
- 9.d: rollback for §3.2 does not exist; deletion is final. Mitigated by the
  terminal print (4.d) and by both rows carrying a dead URL and no usable
  content.

### 9.10 #10 Risks (5 findings, 2 actionable)

- 10.a: **7.b is the highest risk in this session** — silently losing the
  protection that keeps work-in-hand from being demoted. Blast radius: a person
  you already messaged disappears from the queue and the outcome hangs off a
  posting nothing reads. **ACTIONABLE**, and it is the one item that must not be
  deferred to a follow-up.
- 10.b: deleting real contact rows (§3.2). Blast radius small — both carry dead
  links and no context — and the print makes it recoverable by hand.
- 10.c: scope creep toward the learning-loop writes. Same table, same surface,
  and genuinely useful. Held at §9.12 rather than absorbed.
- 10.d: an outcome typed against a wrong or nonexistent `job_id`.
  **ACTIONABLE §2.3** — refuse an unknown id rather than inserting an orphan.
- 10.e: the rates will read as meaningless for weeks, and a meaningless number
  on a dashboard invites being ignored. Accepted (§8) — it can only be built
  forwards.

### 9.11 Net v1.0 changes

| Finding | Section | Change |
|---|---|---|
| **7.b** | §4, §6 | The `sent` rank rule moves to outcome-existence. Without this, deleting `sent` silently orphans work in hand |
| 2.a | §6 step 4 | Removing states from the enum does **not** reach SQL string literals; grep them |
| 1.d / 1.g | §2.2 | PK `(job_id, contact_url)`, `contact_url` defaults to `''` — NULLs are not unique in SQLite |
| 1.a / 1.b | §2.2 | Timestamps nullable, sequence unenforced, first write wins |
| 1.e | §2.2 | Outcomes key on `job_id` and never read state |
| 1.c / 1.f | §2.4 | Zero denominator prints `—`; the 30-day window is inclusive |
| 2.b | §6 step 2 | Re-verify the zero-row reading at execution time |
| 4.d / 9.d | §3.2 | Print the contacts rows before deleting; deletion is final |
| 9.b / 9.c | §3.1, §6 | Backup required; the 12 ids recorded for rollback |
| 5.c | §2.3 | `--declined` prompts for a note but does not refuse without one |
| 6.d | §4 | `CLAUDE.md`'s never-written-states note becomes false; same commit |
| 8.c | §4 | Add a test asserting `JOB_STATES`, since nothing protects it today |
| 10.d | §2.3 | An unknown `job_id` refuses rather than inserting an orphan |
| 7.e | §3.1 | Journal the skipped count before and after, so 12 → 0 does not read as data loss |
| 2.d | — | `recordContact` does not write `role_id`; no future report may assume it |

### 9.12 Open for Mahi

**Do the learning-loop writes ride along, or get their own session?**

Two gaps sit on this exact surface: the agent's `record_contact` /
`record_no_contact` commit a contact but never call `recordDecision`, so the
most valuable judgement in the system records nothing; and `recordCorrection`
is called from tests only, so there is no way to tell the system it was wrong.

For: same table, same files, and `decisions` is the artefact every improvement
path needs — few-shot, retrieval, LoRA, DPO all read those rows.

Against: it is scope beyond §2.4, and §3 says a session should be small enough
to review in twenty minutes. This one already carries a state-machine change and
two live-data migrations.

Recommendation: **its own session, immediately after.** 7.b makes this one
bigger than it looked.

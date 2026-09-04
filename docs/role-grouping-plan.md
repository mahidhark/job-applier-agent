# Plan — group postings into roles

**v1.0. Draft, not ratified.** Stress-tested across all 10 dimensions of
`sop/stress-test-10-dimensions.md`; absorption notes in §8.

---

## 1. The problem, in one screen

```
38 scored postings, 2 companies:  36 Bjak, 2 Skydreams

Bjak's ten highest-scoring, all distinct rows in `jobs`:
    Technical Product Lead - AI Finance
    Technical Product Lead - AI Finance App
    Technical Product Lead - AI Neobank App
    Technical Product Lead - AI Investing App
    Technical Product Lead - AI Stockbroking App
    Technical Product Lead - AI Neobank
    Technical Product Lead - AI Investing
    Technical Product Lead - AI Stockbroking
    Product Lead - AI Stockbroking
     Product Lead - AI Investing App        <- leading space
```

A dedupe already exists (`poll.ts:79-84`) and does nothing here. Its key is
`company + exact title`, so ten distinct strings are ten distinct roles.

Three consequences, in rising order of cost:

1. **The queue lists eight things to do that are one thing.**
2. **Finding the contact costs $0.14, and this would pay it eight times** to
   learn the same one or two humans. Thirty-six Bjak postings is $5.04.
3. **The eval case set cannot be built.** `prepare-cases` takes the top N by
   score, so ten cases would be ten Bjak variants — one question asked ten
   times. It could not even satisfy `validateCases()`, which requires two
   `nobody_findable` cases, impossible at a company where people were found.

## 2. Why this is the right layer to fix it

The first proposal was a per-company cap inside `prepare-cases`. That patches
the last step and leaves the queue and the spend wrong. It is the same mistake
made twice already today: rendering profiles was patched at the display layer
instead of normalised once, and a health table was built to *infer* why a
source was empty instead of reading the field that said so.

**The vision document already specifies the right unit.** From `vision.md`:

> A machine that produces outreach-ready candidates: **a role worth pursuing**,
> a named person who decides, and one grounded observation to open with.

A role. The code drifted to postings, and nothing noticed because postings are
what the boards hand you.

## 3. The model

**A role is a company plus a job, however many times it is advertised.** A
posting is one advertisement of a role.

```
roles                          jobs
  id                             id
  company                        role_id ──────┐
  role_key                       ...           │
  title        <- representative               │
  first_seen                                   │
  ▲────────────────────────────────────────────┘
```

One contact per role, not per posting.

### 3.1 What the grouping key is

`role_key = lower(company) :: normalise(title)`, where `normalise` strips a
trailing qualifier: everything from the first ` - `, ` — ` or ` | ` onward, then
collapses whitespace.

Applied to the ten rows above that yields **two** groups —
`technical product lead` (8) and `product lead` (2) — down from ten.

### 3.2 The honest uncertainty, and how the design handles it

**A group is a hypothesis, not a fact.** "AI Finance App" and "AI Neobank App"
at Bjak might be one role advertised twice or two teams with two managers. The
title cannot settle it, and a cleverer regex would only hide the guess.

So the design does not assert. It:

- **keeps every posting** rather than discarding variants, each with the
  qualifier it was grouped away on (`AI Finance App`), so the group is legible
- **spends once per group**, which is the whole point
- **makes splitting a one-line manual act** (`npm run roles -- --split <jobId>`)
  rather than a re-run
- **surfaces the evidence for a split**: when the contact search for a group
  returns people whose titles carry the group's own qualifiers — a "Head of
  Product, Neobank" alongside a "Head of Product, Finance" — that is printed as
  a suggestion. It is **not** acted on automatically. The information is
  offered; the judgement stays with the operator, which is the same rule the
  agent's tool layer follows.

### 3.3 Which posting represents the group

The one you could actually take, then the freshest:

1. location passes for the operator's country, preferred over one that does not
2. then most recently posted
3. then highest score
4. then lowest id, so the choice is stable across runs

## 4. Changes

| File | Change |
|---|---|
| `src/store/db.ts` | `roles` table; `jobs.role_id`; `upsertRole()`, `roleOf()`, `postingsInRole()` |
| `src/roles/key.ts` | **new.** `roleKey(company, title)` and `qualifierOf(title)`. Pure, no I/O |
| `src/poll.ts` | dedupe block becomes grouping: assign `role_id`, pick a representative, mark variants `variant` |
| `src/queue.ts` | one entry per role; lists the variants under it |
| `src/roles.ts` | **new.** `npm run roles` to list groups; `--split <jobId>` to break one out |
| `src/eval/prepare-cases.ts` | select by role rather than by posting |
| `src/status.ts` | report roles alongside postings |
| `src/explain.ts` | say "grouped into role X with 7 others" |

### 4.1 A new state, not a reused one

Variants get their own state, `variant` — they do **not** reuse `skipped`.

`skipped` currently means two unrelated things: *"a duplicate the machine
dropped"* (`poll.ts:82`) and *"a role Mahi does not want"* (`queue.ts:32`). This
change would make the first far more common and permanently blur the second.
See finding #7.a.

## 5. What this does not do

- **No model call.** The key is a pure function; grouping stays free and
  auditable, like the gates.
- **No merging across companies.** Same title at two employers is two roles.
- **No retroactive regrouping of `sent` postings.** History stays as recorded.
- **No change to what is contacted.** The agent still stops at the queue.

## 6. Sequence

1. `src/roles/key.ts` + tests, against the ten real Bjak titles
2. Schema: `roles`, `jobs.role_id`, backfill existing rows
3. `poll.ts` grouping
4. `queue.ts`, `status.ts`, `explain.ts`
5. `npm run roles` and `--split`
6. `prepare-cases` selects by role
7. Re-run `poll:once`, confirm Bjak collapses 36 → a handful

## 7. Done when

- The ten Bjak titles form two roles, not ten
- `npm run queue` shows one Bjak entry naming its variants
- `prepare-cases -- --n 10` returns ten distinct **companies-or-roles**, never
  ten variants of one
- Splitting a wrongly-grouped role takes one command
- Test count rises; `npm run typecheck` clean

---

## 8. v1.0 10-dimension stress-test absorption notes

### 8.1 #1 Edge cases (7 findings, 5 actionable)

- **1.a** A title that is *entirely* a qualifier (`"- AI Finance"`) normalises to
  the empty string, and every such posting at a company collapses into one
  nameless role. **ACTIONABLE §3.1** — when normalisation yields fewer than 3
  characters, fall back to the raw title.
- **1.b** The leading space in `" Product Lead - AI Investing App"` is real, in
  the live data. Already handled by trimming, but it is why trimming is not
  optional. **✓ VERIFIED** against the actual rows.
- **1.c** Separator characters vary: hyphen, en dash, em dash, pipe, and the
  comma form `"Product Lead, Growth"`. **ACTIONABLE §3.1** — match a character
  class, and treat a comma as a separator only when what follows is short
  (under ~25 chars), or `"Product Manager, Payments and Risk Platform"` loses
  its meaning.
- **1.d** Two postings in the same group could both be the representative if
  scores tie and `postedAt` is null on both. **ACTIONABLE §3.3** — the final
  tiebreak on lowest id exists for this; without it the queue reshuffles
  between runs for no reason.
- **1.e** A role's representative may later be `sent` or `skipped` by hand,
  leaving the group with no live representative. **ACTIONABLE §4** —
  representative is computed on read, not stored, so it re-picks from what is
  still live. If nothing is live the role drops out of the queue, which is
  correct.
- **1.f** `job.company` is free text from the board; the same employer can
  appear as `"Bjak"` and `"Bjak Sdn Bhd"` and split a role in two. **(no
  action)** — out of scope, and the existing dedupe has the same limitation.
  Noted in §5 as a known boundary.
- **1.g** Backfilling `role_id` over the existing 3,088 rows must be
  idempotent, since a second run must not create duplicate roles.
  **ACTIONABLE §6** — `upsertRole` keyed on `(company, role_key)` with a unique
  index.

### 8.2 #2 Unverified assumptions (4 findings, 2 actionable)

- **2.a** *"Grouping saves $0.14 per avoided lookup."* Verified: `TOOL_COST_USD`
  in `src/agent/tools/index.ts` reads `find_people_at_company: 0.14` as of the
  Full-mode change. **✓ VERIFIED** by reading the file, not recalling it.
- **2.b** *"Eight Bjak postings are one role."* **NOT VERIFIED, and cannot be
  from titles alone.** This is the central assumption of the plan. §3.2 is the
  entire response to it: group as a hypothesis, make splitting cheap, surface
  evidence rather than act on it. **ACTIONABLE §3.2** — and flagged
  `[Mahi-verify]` after the first real grouping run.
- **2.c** *"The dedupe currently drops nothing useful."* Verified: 12 postings
  are in `skipped`, and the dedupe key is exact-title, so those 12 were literal
  repeats. **✓ VERIFIED** via the store.
- **2.d** *"prepare-cases over-samples one company."* Verified by reading
  `src/eval/prepare-cases.ts:50` — `ORDER BY score DESC LIMIT ?`, no company
  or role term. **ACTIONABLE §4**.

### 8.3 #3 Actual code checks (5 findings, all verified)

- **3.a** `poll.ts:79-84` dedupe block read in full; key confirmed as
  `company::title` lowercased with whitespace collapsed. **✓ VERIFIED**
- **3.b** `jobs` schema read at `db.ts:19-32`; no `role_id`, so this is an
  additive migration. `raw` holds the original posting, so a qualifier can be
  recovered without a re-fetch. **✓ VERIFIED**
- **3.c** `queue.ts:37-40` selects `state IN ('scored','enriched','queued')`
  ordered by score. Grouping changes what it must select. **✓ VERIFIED**
- **3.d** `JobPosting` in `sources/types.ts` has no role concept and no stable
  employer id — only free-text `company` plus an optional
  `companyLinkedinUrl`. Confirms 1.f is a real boundary. **✓ VERIFIED**
- **3.e** `contacts` is keyed `(job_id, profile_url)` at `db.ts:41-49`. One
  contact per role therefore needs either a `role_id` column or the discipline
  of always recording against the representative. **ACTIONABLE §4** — add the
  column; relying on discipline is how the two `MCP` clients got orphaned.

### 8.4 #4 Security (2 findings, 0 actionable)

- **4.a** No new external input. Role keys derive from data already stored, and
  the key function is pure with no shell, no SQL string building, no network.
  **✓ ALIGNED**
- **4.b** `roles` holds a company name and a job title — no personal data, so
  it does not change the repo's data posture. Contacts remain outside git.
  **✓ ALIGNED**

### 8.5 #5 Vision alignment (2 findings, 0 actionable)

- **5.a** `vision.md` defines the product as producing *"a role worth pursuing,
  a named person who decides, and one grounded observation"*. The plan moves
  the code toward the vision's own noun. **✓ ALIGNED** — and the drift is
  itself worth recording: the vision said role, the code said posting, and
  nothing reconciled them.
- **5.b** Cost prudence: grouping strictly reduces paid calls and adds none.
  **✓ ALIGNED**

### 8.6 #6 Architecture consistency (3 findings, 1 actionable)

- **6.a** `src/roles/key.ts` as a pure function beside `src/screen/gates.ts`
  and `src/score/score.ts` matches the established shape — the deterministic
  layer stays model-free and testable without I/O. **✓ ALIGNED**
- **6.b** `poll.ts` remains the only orchestrator; grouping is a library it
  calls. **✓ ALIGNED**
- **6.c** Representative selection needs the operator's country, which lives in
  `config.screen.homeLocalities` / `operatorCountry`. Reaching into screening
  config from a role module couples two layers. **ACTIONABLE §3.3** — pass the
  predicate in from `poll.ts`, which already holds the config, rather than
  importing it.

### 8.7 #7 Impact on other features (4 findings, 3 actionable)

- **7.a — state-machine sub-analysis, TRIGGERED.** This change adds a state and
  increases traffic into one. Tabulated:

  | state | producers | consumers | operator actions |
  |---|---|---|---|
  | `skipped` | `poll.ts:82` duplicate; `queue.ts:32` manual | `status.ts` counts; `queue.ts` excludes | `queue -- --skip <id>` |
  | `variant` *(new)* | `poll.ts` grouping | `queue.ts` lists under its role; `status.ts` counts | `roles -- --split <id>` |

  Parity check: every action offered in `variant` must work in `variant`.
  `--split` promotes a variant to its own role and re-scores it; `--skip` on a
  variant must also work, and must not be silently swallowed. **ACTIONABLE
  §4.1** — `variant` is a new state precisely so that `skipped` keeps meaning
  "Mahi does not want this". Overloading it would make the two
  indistinguishable and the count in `status` meaningless.
- **7.b** `explain.ts` answers "why was this posting skipped". After grouping,
  the answer for most Bjak rows becomes "it is a variant of role X", which is a
  new sentence it does not have. **ACTIONABLE §4**.
- **7.c** `npm run agent -- <id>` takes a posting id. It should keep working on
  a variant id and record the contact against the role. **ACTIONABLE §4** —
  resolve to the role before recording.
- **7.d** Existing `scored` rows have no `role_id` until the backfill runs, so
  every consumer must tolerate a null. **(no action)** — the backfill is part
  of the same migration, but the null-tolerance is stated in §6 anyway because
  a partially-run migration is a real state.

### 8.8 #8 Test coverage (3 findings, 2 actionable)

- **8.a** `roleKey` must be tested against **the ten real Bjak titles**, not
  invented ones. The `headline` bug proved that invented fixtures pass while
  reality fails. **ACTIONABLE §6** — copy the titles verbatim from the store.
- **8.b** Grouping correctness needs a negative test too: two genuinely
  different roles at one company must **not** merge. **ACTIONABLE §6** — use
  Skydreams' two real postings, which are different roles.
- **8.c** Current baseline is 109 tests, all passing. Recorded here as the
  regression floor. **✓ VERIFIED**

### 8.9 #9 Deployment & rollback (3 findings, 2 actionable)

- **9.a** The schema change is additive — a new table and a nullable column —
  so an old build reads the database fine and simply ignores `role_id`.
  **✓ ALIGNED**
- **9.b** Rollback is `git revert` plus nothing: the `roles` table and
  `role_id` can stay in place unused. But rows moved to `variant` would be a
  state an older build does not know. **ACTIONABLE §6** — the rollback step is
  one `UPDATE jobs SET state='scored' WHERE state='variant'`, written into the
  plan rather than improvised later.
- **9.c** This repo has no migration runner; `db.ts` runs `CREATE TABLE IF NOT
  EXISTS` at import. A backfill is therefore a one-shot script, not a
  migration. **ACTIONABLE §6** — `npm run roles -- --backfill`, idempotent, run
  once by hand.

### 8.10 #10 Risks (4 findings)

- **10.a** *Wrong merges hide real jobs.* If "AI Finance" and "AI Neobank" are
  genuinely separate roles, grouping hides one behind the other and an
  opportunity is silently lost. **Blast radius: moderate. Mitigation:** variants
  stay visible under their group rather than being discarded, and `--split` is
  one command. This is the main risk the plan accepts.
- **10.b** *Over-splitting wastes money instead.* A conservative key that
  merges almost nothing leaves the $5.04 problem in place. **Mitigation:** the
  done-when in §7 is a number — the ten Bjak titles must become two roles.
- **10.c** *The eval set gets built on a wrong grouping* and every later
  measurement inherits it. **Mitigation:** sequence — grouping lands and is
  eyeballed before `cases:prepare` spends anything. **[Mahi-verify]** after the
  first run.
- **10.d** *Scope.* Eight files, a schema change and a new command is more than
  a session. **Mitigation:** §6 sequences it so steps 1-3 are independently
  useful; if we stop after step 3 the grouping exists and only the reporting is
  missing.

### 8.11 Net v1.0 changes

| Finding | Section | Change |
|---|---|---|
| 1.a | §3.1 | fall back to raw title when the key is under 3 chars |
| 1.c | §3.1 | separator character class; comma only for short qualifiers |
| 1.d | §3.3 | lowest-id final tiebreak, so ordering is stable |
| 1.e | §4 | representative computed on read, never stored |
| 1.g | §6 | `upsertRole` idempotent, unique index on (company, role_key) |
| 2.b | §3.2 | group as hypothesis; `[Mahi-verify]` after first run |
| 2.d, 3.e, 7.b, 7.c | §4 | `contacts.role_id`; explain/agent/prepare-cases updated |
| 6.c | §3.3 | location predicate passed in, not imported |
| 7.a | §4.1 | `variant` is a new state, not overloaded `skipped` |
| 8.a, 8.b | §6 | tests use the real Bjak and Skydreams titles |
| 9.b, 9.c | §6 | written rollback UPDATE; `--backfill` one-shot |
| 10.c | §6 | grouping verified before any eval spend |

### 8.12 Open for Mahi

- **[Mahi-verify] 2.b / 10.c** — after the first grouping run, confirm the Bjak
  groups are right before `cases:prepare` spends anything.
- **Scope (10.d)** — steps 1-3, or all seven?

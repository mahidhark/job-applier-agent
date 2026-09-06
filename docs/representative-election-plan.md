# Plan v1.0 — one representative per role, on every pass

*Stress-tested across all 10 dimensions per `sop/stress-test-10-dimensions.md`;
absorption notes in §9. Draft — not ratified.*

## 1. The bug

A role is supposed to have exactly one representative — the posting that takes
the queue slot — with every other listing sitting in `variant` underneath it.
On 2026-09-06, two roles had two:

```
roles with more than one representative: 2
  bjak::bjak::technical product manager
  bjak::bjak::technical product lead
```

Both showed in `npm run roles` with two `→` markers, and both would have taken
two queue slots and two paid contact lookups for the same job.

`npm run repair` plus a backfill cleared them, so the store is clean today. **The
cause is untouched.** The next poll that adds a posting to a role that already
exists will do it again.

## 2. Why it happens

`poll.ts` groups **only the survivors of the current pass**:

```ts
const groups = new Map<string, typeof survivors>();
for (const job of survivors) { ... }          // survivors = new postings only

for (const [key, members] of groups) {
  const ranked = [...members].sort(...);      // ranks THIS PASS only
  for (const [i, job] of ranked.entries()) {
    if (i === 0) setState(job.id, 'scored');  // elects a second representative
    else setState(job.id, 'variant');
  }
}
```

`upsertJob` returns false for a posting already seen, and `poll` skips those, so
`survivors` can never contain the incumbent. There is no code path anywhere in
`poll.ts` that demotes an existing `scored` row. A role therefore accumulates
one representative per pass in which it gains a posting.

It stayed hidden because it needs two conditions at once: a role that already
exists, and a *new* posting joining it. Both free boards were stable for weeks,
so nothing joined an existing role — until paid LinkedIn discovery turned on and
brought three `BJAK` postings into roles that Ashby had already created.

## 3. The fix — one election, two callers

`roles.ts --backfill` already elects correctly, including the rule that a
contacted posting is never demoted. `poll.ts` has a second, weaker copy of the
same idea. Two copies of a rule is how they drift, and this one drifted into a
bug.

Extract one pure function, `src/roles/elect.ts`:

```ts
export interface Candidate {
  id: string;
  postedAt: string | null;
  score: number | null;
  /** An outcome has been recorded against it — somebody has been contacted. */
  contacted: boolean;
  /** Its current state, so a rejected or skipped posting is never elected. */
  state: string;
}

/** Returns the members in election order. The first is the representative. */
export function elect(candidates: Candidate[]): Candidate[];
```

`poll.ts` then loads the role's existing members with `postingsInRole(key)`,
merges them with the pass's new survivors, and elects across the union. Exactly
one row ends `scored`; every other ends `variant`.

### 3.1 The order, and one change to it

1. **Contacted first.** A posting somebody has been messaged about is never
   demoted. This is the rule §7.b of the outcome-capture plan moved out of the
   `sent` state; it must survive the extraction unchanged.
2. **Then the incumbent, on a tie.** *New in this plan* — see §9.11 finding
   10.b. Freshest, then best score, then lowest id, exactly as today, but where
   those are all equal the posting that is **already** the representative keeps
   the slot. Without this, two postings that tie can swap the slot every pass
   and the queue reshuffles daily for no reason a reader can see.
3. Then freshest `posted_at`, then highest score, then lowest id.

A challenger takes the slot only by being **strictly better**, never by
arriving.

### 3.2 What must never happen

- A `skipped` posting must never be elected. Mahi rejected it; grouping has no
  standing to bring it back (#1.a).
- A contacted posting must never be demoted (#1.b).
- The election must be deterministic. The same store, twice, gives the same
  representative — otherwise the queue is different each morning for no reason.

## 4. Changes

| file | change |
|---|---|
| `src/roles/elect.ts` | new — the pure election, and the only copy of the rule |
| `src/roles/elect.test.ts` | new — ~10 tests, all pure, no database |
| `src/poll.ts` | merge existing members before electing; demote losers |
| `src/roles.ts` | backfill calls `elect()` instead of its own sort |
| `CLAUDE.md` | the one-representative invariant, stated where it can be found |

## 5. Sequence

1. `git checkout -b fix/representative-election`
2. `src/roles/elect.ts` + tests, pure, no callers yet
3. `roles.ts --backfill` switches to it — behaviour must be unchanged, and the
   store is the proof: a backfill after this step must move zero rows
4. `poll.ts` merges existing members and elects across the union
5. `npm run poll -- --once` twice in a row; the second pass must move nothing
6. `npm test`, `npm run typecheck`, `CLAUDE.md` and journal in the same commit

## 6. Done when

`npm run poll -- --once` run twice against a store that already has roles leaves
**exactly one** `scored` row per role, no role loses its representative, and no
posting with an `outcomes` row is demoted.

## 7. Risks accepted

- **The representative can now change on a normal poll.** It could not before,
  because nothing demoted an incumbent. That is the point, and §3.1's
  incumbency tie-break is what stops it becoming churn.
- **The protection only knows about *recorded* outreach.** If Mahi messages
  somebody and does not type `--sent`, the system cannot know, and that posting
  can be demoted. Real, and not fixable here — see finding 10.b.

---

## 8. v1.0 10-dimension stress-test absorption notes

All 10 walked. 26 findings, 11 actionable. The #7 state-machine sub-analysis is
**triggered** — this change adds a `scored → variant` transition to `poll.ts`
that did not exist there before.

### 8.1 #1 Edge cases (7 findings, 6 actionable)

- 1.a: an incumbent in `skipped` — Mahi rejected it, and an election must not
  resurrect it. **ACTIONABLE §3** — `elect()` filters on state before ranking,
  and `skipped` is never a candidate.
- 1.b: an incumbent with an outcome row, beaten on score by a newcomer. It must
  still win. **ACTIONABLE §3.1** — contacted sorts first, unconditionally.
- 1.c: **every** member of a role is `skipped`. The role then has no
  representative at all. `elect()` must return an empty list rather than
  throwing, and `poll` must not write a representative that does not exist.
  **ACTIONABLE §3.**
- 1.d: two postings with `posted_at` NULL and equal scores. `poll.ts` already
  maps a null date to 0; the id tiebreak resolves it. **ACTIONABLE §3.1** — the
  id tiebreak must come last and must be total, or the sort is unstable.
- 1.e: a *new* posting ties the incumbent exactly. **ACTIONABLE §3.1** — the
  incumbency rule, which is the only reason it is in this plan.
- 1.f: a role that exists in `roles` but has zero live postings. `postingsInRole`
  returns an empty array; nothing should crash and no role row should be
  written. (no action — `elect([])` returning `[]` covers it.)
- 1.g: the same posting appearing in both the new survivors and
  `postingsInRole` — possible if `upsertJob` behaviour ever changes.
  **ACTIONABLE §3** — dedupe the union by id before electing, so a posting
  cannot be its own challenger.

### 8.2 #2 Unverified assumptions (5 findings, 2 actionable)

- 2.a ✓ VERIFIED: `postingsInRole(roleId)` returns
  `{ id, title, url, state, score, posted_at, location }` — everything the
  election needs. It does **not** return `company`, and the election does not
  need it.
- 2.b **FALSE, and it is the familiar shape**: the assumption that poll's
  survivors and the store's rows can be sorted by the same code.
  `JobPosting.postedAt` is camelCase; `RolePosting.posted_at` is snake_case.
  Handing both to one sort silently reads `undefined` on one of them and every
  date becomes 0. This is the same class of bug as reading `headline` from a
  source that returns `summary` — the field was there and nothing read it.
  **ACTIONABLE §3** — `elect()` takes a normalised `Candidate`, and both callers
  map into it explicitly.
- 2.c: the claim that only two roles were ever affected. That was a reading on
  2026-09-06 **before** the repair; it is zero now. **ACTIONABLE §5 step 5** —
  the proof is that a second consecutive poll moves nothing, not a row count.
- 2.d ✓ VERIFIED: `poll.ts` never calls backfill, so the bug only ever manifests
  across passes and never within one.
- 2.e ✓ VERIFIED: `upsertJob` returns false for a posting already in the store
  and `poll` `continue`s on it, so `survivors` genuinely cannot contain an
  incumbent. The bug is structural, not a race.

### 8.3 #3 Actual code checks (5 findings, all verified)

- 3.a ✓ `poll.ts:133-177`: groups built from `survivors`; the sort at :153 sees
  only this pass; no `setState(_, 'variant')` anywhere for a row not in
  `groups`.
- 3.b ✓ `roles.ts:98-120`: the backfill rank already handles contacted-first
  (post outcome-capture) and demotion. It is the correct copy, and the one to
  extract.
- 3.c ✓ `postingsInRole` orders `score DESC, id ASC` — **not** the election
  order. The election must re-sort rather than trusting the query.
- 3.d ✓ `setState(id, state: JobState)` and `setRoleId(jobId, roleId)` both take
  one row at a time; electing across a union means more writes per pass, which
  at 21 roles is irrelevant.
- 3.e ✓ `poll.ts` holds a `scores` Map for new survivors only. Existing members
  carry their score in the row `postingsInRole` returns, so no rescoring is
  needed and none should be done — rescoring an old posting against today's
  config would silently rewrite history.

### 8.4 #4 Security (3 findings, 0 actionable)

- 4.a ✓ No new data, no personal data, no new columns. The election reads ids,
  dates, scores and states.
- 4.b ✓ No network, no spend. `elect()` is pure.
- 4.c ✓ No new dependency.

### 8.5 #5 Vision alignment (3 findings, 0 actionable)

- 5.a ✓ ALIGNED: `vision.md` says the scarce resource is a specific true thing
  said to a named human. Two queue slots for one job spends that attention
  twice, and `CLAUDE.md` already states that the queue counts roles.
- 5.b ✓ ALIGNED: a duplicate representative is also a duplicate **paid** lookup
  for the same person — the cost model in `poll.ts` exists to stop exactly that.
- 5.c ✓ No send path touched.

### 8.6 #6 Architecture consistency (4 findings, 2 actionable)

- 6.a: `src/roles/elect.ts` sits beside `key.ts` and `taxonomy.ts`, matching the
  module's existing split of pure logic from callers. **ACTIONABLE §4.**
- 6.b: two copies of one rule is the actual defect here, not the missing merge.
  **ACTIONABLE §4** — after this, `elect()` is the only place the order is
  written down, and `roles.ts` loses its private sort.
- 6.c ✓ `poll.ts` stays the only orchestrator; `elect()` is a library it calls.
- 6.d ✓ Pure function, no I/O, consistent with `gates.ts`, `score.ts` and
  `key.ts` — which is what makes it testable without a database.

### 8.7 #7 Impact on other features — **STATE-MACHINE SUB-ANALYSIS TRIGGERED**

This change adds a `scored → variant` transition to `poll.ts` that did not
previously exist there.

| state | producers | consumers | affordance |
|---|---|---|---|
| `scored` | `poll.ts:166`, `roles.ts:114`, **new: `poll.ts` election** | `queue.ts` SELECT, `status.ts`, `roles.ts` | listed by `queue` |
| `variant` | `poll.ts:173`, `roles.ts:119`, **new: `poll.ts` demotion** | `roles.ts`, `postingsInRole` | listed under its role |
| `skipped` | `queue.ts` `--skip` | `status.ts` | `--skip` |

- 7.a: **a row can now leave `scored` on an ordinary unattended poll.** Before,
  only an explicit `--skip` or a manual backfill moved it. Parity check: every
  consumer of `scored` reads it fresh per invocation — `queue.ts` and
  `status.ts` both SELECT at run time — so none can hold a stale representative.
  ✓ PARITY OK.
- 7.b: a demoted posting is still visible. `queue.ts` lists variants under their
  role via `postingsInRole`, so the listing does not disappear from view even
  when the slot changes hands. ✓ PARITY OK.
- 7.c: `status.ts` "TOP SCORED, NOT YET CONTACTED" selects `state = 'scored'`.
  After the fix it returns fewer rows, which is the correction, not a
  regression. **ACTIONABLE §5** — journal the count before and after so it does
  not read as data loss, the same way the 12 stranded rows were handled.
- 7.d: `npm run agent -- <id>` takes a job id directly and does not care about
  state, so a demotion mid-flight does not break an enrichment run. ✓
- 7.e: `explain.ts` reads gates per posting and is unaffected by state. ✓

### 8.8 #8 Test coverage (4 findings, 3 actionable)

- 8.a: `elect()` is pure, so every rule in §3.1 is a unit test with no database.
  **ACTIONABLE §4** — contacted wins over a better score; incumbent wins a tie;
  `skipped` is never elected; empty input returns empty; the id tiebreak is
  total.
- 8.b: the integration property is "two passes, one representative".
  **ACTIONABLE §5 step 5** — assert it against a temp database, never the live
  one.
- 8.c ✓ VERIFIED: `roles.ts` backfill has no test today. Extracting the rule is
  the first time it becomes testable at all.
- 8.d: baseline **227**; target **~240**. **ACTIONABLE §4.**

### 8.9 #9 Deployment & rollback (3 findings, 1 actionable)

- 9.a ✓ No schema change, no migration, no deploy. Rollback is reverting the
  commit.
- 9.b: `poll` writes state, so a wrong election changes live rows. Mitigated by
  the change being idempotent — `npm run roles -- --backfill` recomputes from
  the same rule and repairs any state. **ACTIONABLE §5** — step 3 proves the
  extraction is behaviour-preserving *before* step 4 changes `poll`.
- 9.c ✓ The pre-migration backup from 2026-09-06 still exists at
  `~/agent.db.bak-2026-09-06`, though it predates the outcome-capture repairs
  and is not a clean rollback target for this change.

### 8.10 #10 Risks (5 findings, 2 actionable)

- 10.a: **churn.** If the representative changes every pass, the queue
  reshuffles daily and Mahi loses his place. Blast radius: trust in the queue,
  which is the product. **ACTIONABLE §3.1** — incumbency wins ties, so a
  challenger must be strictly better.
- 10.b: **the contacted protection only knows about recorded outreach.** If
  Mahi messages somebody and does not type `--sent`, the system has no way to
  know, and that posting is demotable. Not fixable here — the fix is that
  recording is cheap and habitual, which is what outcome capture just shipped.
  **ACTIONABLE §7** — named as an accepted risk rather than left implicit.
- 10.c: electing across a union means `poll` now writes state for postings it
  did not see this pass. A bug here touches rows the pass never looked at.
  Mitigated by 9.b's idempotence and by step 3 proving the rule first.
- 10.d: `postingsInRole` per group per pass is N queries. At 21 roles this is
  nothing; at 500 it is still nothing next to a network fetch. (no action.)
- 10.e: the bug is currently **latent, not active** — the store is clean. So
  this ships with no visible symptom to confirm against, which is why §6's
  done-when is a property (two passes, one representative) rather than a count.

### 8.11 Net v1.0 changes

| Finding | Section | Change |
|---|---|---|
| 2.b | §3 | `elect()` takes a normalised `Candidate`; `postedAt` vs `posted_at` would otherwise zero every date |
| 10.a / 1.e | §3.1 | **New rule**: incumbency wins a tie. A challenger must be strictly better |
| 1.a / 1.c | §3.2 | `skipped` is never a candidate; an all-skipped role elects nobody rather than throwing |
| 1.b | §3.1 | Contacted sorts first, unconditionally — the outcome-capture rule survives the extraction |
| 1.g | §3 | Dedupe the union by id, so a posting cannot challenge itself |
| 6.b | §4 | `roles.ts` loses its private sort; `elect()` becomes the only copy of the rule |
| 3.e | §3 | Never rescore an existing member — that would rewrite history against today's config |
| 9.b | §5 | Step 3 proves the extraction moves zero rows before step 4 touches `poll` |
| 7.c | §5 | Journal the `scored` count before and after |
| 8.d | §4 | 227 → ~240 |
| 10.b | §7 | Unrecorded outreach is undemotable-by-nothing; named as accepted |

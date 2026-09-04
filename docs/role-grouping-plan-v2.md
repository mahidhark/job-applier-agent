# Plan v2.0 — judged grouping, and the corrections substrate

**Draft, not ratified.** Stress-tested across all 10 dimensions of
`sop/stress-test-10-dimensions.md`; absorption notes in §10.

Supersedes the design in `role-grouping-plan.md` §3.2. That plan's scope A
shipped and works; this changes who makes the decision.

---

## 1. Why v2.0

v1.0 grouped on a string key and called the group a hypothesis. The first run
proved the hypothesis wrong exactly where the plan predicted:

```
  Skydreams — Senior Product Manager
   →  Homedeal   · Utrecht (Hybrid)
      Moving24   · Utrecht          [variant]
```

Homedeal and Moving24 are brands under one parent. Two brands, two managers,
two jobs — one now hidden behind the other. And **no key can fix it**: that
string is structurally identical to `Technical Product Lead - AI Neobank`,
which should merge.

v1.0's answer was a `--split` command. Mahi's correction, which is the reason
for v2.0:

> the user is not expected to fix this deterministically — the model is
> supposed to learn this and use its own judgement

Both halves are right, and they are different requirements. **Judgement** means
the decision moves to a model. **Learning** means the model's next decision is
informed by the last correction. This plan builds the second first, because
without it the first cannot improve.

### 1.1 The judgement is available; the current code just never looks at it

The answer is not in the title. It is in the description: Homedeal is a
home-services marketplace, Moving24 is a moving company. Bjak's eight are all
the same fintech product org. `jobs.raw` already holds every description, and
grouping reads only the title. **This is a context problem before it is a model
problem** — the exact failure shape as reading `headline` from a source that
returns `summary`.

## 2. Where models belong, across the whole pipeline

The frame, so this plan is not read as "a model for grouping and nothing else".

| stage | today | should be | why |
|---|---|---|---|
| screening 3,088 → 38 | pure functions | **keep**, plus a model reviewing *rejections* | `title_wanted` rejected 1,976 on regex; "Founder's Office Lead" may be a fine role and nobody will ever know. False negatives are invisible today |
| ranking the survivors | weighted sum | keep for now | ranking errors are cheap — you work down a list |
| **grouping** | string key | **model, on descriptions** | this plan |
| enrichment | model + tools | keep | already the right shape |
| drafting | not built | model, style learned from edits | the clearest DPO case, and the furthest away |

**The best case for a small trained model is the first row, not the fourth.**
High volume, one narrow judgement each, and the right answer is whatever Mahi
would have said. That is the opposite of where an SLM is usually proposed.
Out of scope here, recorded so the shape is not lost.

## 3. The corrections substrate

One table, and the reason it comes first: **every path forward needs the same
artefact.** Few-shot needs examples. Retrieval needs stored decisions. LoRA
needs graded pairs. DPO needs chosen-vs-rejected. All four are the same rows.
The system currently records none of them, so no path is open.

```sql
CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- 'group' | 'contact' | 'screen' | 'draft'
  subject       TEXT NOT NULL,   -- role id, job id
  context       TEXT NOT NULL,   -- JSON: what the decider was shown
  chose         TEXT NOT NULL,   -- JSON: what it decided
  reasoning     TEXT,            -- why, in its own words
  decider       TEXT NOT NULL,   -- 'anthropic:claude-...', or 'key' when it fell back
  corrected_at  TEXT,            -- null until Mahi disagrees
  corrected_to  TEXT,            -- JSON: what is actually right
  correction_note TEXT           -- WHY it was wrong. The valuable field
);
```

`kind` is open from the start so contacts and drafts land in the same table
later without a migration.

`correction_note` is the field that matters. *"Homedeal and Moving24 are
separate brands"* is worth more than the corrected partition, because it
generalises and the partition does not.

## 4. Judged grouping

### 4.1 The key stops deciding

`roleKey` becomes a **candidate generator**: cheap, deterministic, proposing
"these 8 might be one role". The model disposes. This mirrors the existing
shape — gates filter deterministically, judgement happens on survivors.

Only candidates with more than one member are judged. On the current store that
is 6 model calls, not 38.

### 4.2 What the model is shown, and what it returns

Shown: the company, and for each posting its title, its qualifier, and the
first ~1,200 characters of its description.

Returns a partition, with per-group reasoning and an explicit confidence:

```ts
{ groups: [ { jobIds: string[], roleTitle: string, reasoning: string,
              confident: boolean } ] }
```

### 4.3 When unsure, split

**Not symmetric, and this is the load-bearing rule.**

Over-splitting is cheap and visible: $0.14 paid twice, two queue entries for
one job, and you notice. Over-merging is **invisible** — a job never seen, a
manager never contacted, and no signal ever arrives. You cannot learn from an
opportunity you did not know existed.

So any group of more than one member that the model does not mark `confident`
is split into singletons. The default favours the error you find out about.

### 4.4 Learning, without training

Before judging, the prompt is given prior corrections: every correction for the
**same company**, plus the 3 most recent others. Retrieval, not fine-tuning —
it works today, on a hosted model, with no GPU and no training run.

Corrected once, Skydreams never regroups wrongly again, and the note about
brands is in front of the model the next time any multi-brand parent appears.

The same rows are the training set if that is ever wanted. This plan does not
choose; it keeps the choice open.

### 4.5 Correcting

```bash
npm run roles -- --split <roleId> --note "Homedeal and Moving24 are separate brands"
```

Applies the split and records the correction. The note is required — a
correction without a reason teaches nothing.

## 5. Failure and cost

**The model must not be able to break the poll.** `poll` runs unattended on a
timer. If the judge errors or times out, grouping falls back to the v1.0 key,
records `decider: 'key'`, and the group is re-judged on a later pass. A
degraded grouping is recoverable; a poll that stops is not.

Cost: 6 candidate groups × roughly 3k tokens. Cents per pass, and bounded by
*new* candidate groups rather than by the store's size.

## 6. Changes

| File | Change |
|---|---|
| `src/store/db.ts` | `decisions` table; `recordDecision()`, `recordCorrection()`, `correctionsFor()` |
| `src/roles/judge.ts` | **new.** The judge: prompt, schema, retrieval of prior corrections, split-on-unsure |
| `src/roles/key.ts` | unchanged — it is now a candidate generator |
| `src/poll.ts` | judge each multi-member candidate; fall back to the key on error |
| `src/roles.ts` | show reasoning; `--split <roleId> --note` records a correction |
| `src/eval/cases.ts` | a grouping case shape, so this is gradeable |

## 7. What this does not do

- **No training.** No LoRA, no DPO, no adapter. It builds the data those need.
- **No SLM.** Uses `modelForTask(config, 'judge')`, which is already a config
  switch across anthropic / cerebras / ollama. Swapping in a local model later
  is a config change, not a rewrite.
- **No model in screening or scoring.** Recorded in §2 as future work.
- **No automated re-grouping of corrected roles.** A correction is final until
  Mahi says otherwise.

## 8. Sequence

1. `decisions` table and its three functions, with tests
2. `judge.ts` against the six real candidate groups, dry-run, printing only
3. Compare to v1.0's grouping and read the differences — **[Mahi-verify]**
4. Wire into `poll.ts` behind the fallback
5. `--split ... --note`, and reasoning shown in `npm run roles`
6. Grouping as an eval case shape

## 9. Done when

- Skydreams splits into two roles; the six Bjak groups stay merged
- Every grouping decision has stored reasoning readable in `npm run roles`
- A correction recorded once changes the next judgement of a similar group
- The judge failing leaves grouping working and the poll running
- Test count rises; `npm run typecheck` clean

---

## 10. v2.0 10-dimension stress-test absorption notes

### 10.1 #1 Edge cases (6 findings, 5 actionable)

- **1.a** A candidate group of 30+ postings would blow the context window at
  1,200 chars each. **ACTIONABLE §4.2** — cap at 12 postings shown; beyond
  that, judge the 12 and apply the partition by qualifier to the rest, marking
  the decision `partial` in `context`.
- **1.b** A posting with an empty description gives the judge nothing to work
  with, and Ashby/Lever both sometimes omit it. **ACTIONABLE §4.3** — a group
  where more than half the descriptions are empty cannot be `confident`, so it
  splits. Falls out of the existing rule rather than needing a new one.
- **1.c** The model may return a partition that drops or duplicates job ids.
  **ACTIONABLE §4.2** — validate the partition covers the input exactly once;
  on mismatch, treat as unconfident and split. Never trust the shape.
- **1.d** Two postings, identical title and identical description, different
  ids. Genuine board duplicates. **(no action)** — merge is correct and the
  model will say so.
- **1.e** A correction may name job ids that have since been re-polled into
  different states. **ACTIONABLE §6** — corrections key on role id and
  qualifier text, not job id, so they survive a re-poll.
- **1.f** `--split` on a role with one posting is a no-op the operator may
  still type. **ACTIONABLE §4.5** — say so plainly rather than silently
  succeeding.

### 10.2 #2 Unverified assumptions (5 findings, 3 actionable)

- **2.a** *"The description distinguishes Homedeal from Moving24."* **NOT YET
  VERIFIED.** Plausible from the brand names, but I have not read the two
  descriptions. **ACTIONABLE §8** — step 2 is a dry run precisely so this is
  checked before anything is wired in. If the descriptions do not distinguish
  them, the whole plan needs rethinking, and better to learn that at step 2
  than step 4.
- **2.b** *"`modelForTask(config, 'judge')` works."* Verified: `TaskName`
  includes `'judge'` at `src/ai/index.ts:17` and `modelForTask` resolves a
  provider at line 48. **✓ VERIFIED** by reading the file.
- **2.c** *"`generateObject` is available."* Verified: `ai@^7.0.92` and `zod`
  are both direct dependencies. **✓ VERIFIED** in package.json.
- **2.d** *"6 model calls per pass."* True for the current store, but a real
  discovery run brings many companies and many more groups. **ACTIONABLE §5** —
  state the bound as *new candidate groups per pass*, and note it grows with
  the funnel.
- **2.e** *"Retrieval of past corrections will improve the next judgement."*
  Assumed, not measured. It is the standard result but this is n=0 here.
  **ACTIONABLE §8** — the eval case shape in step 6 is what makes it testable;
  until then it is a reasonable bet, labelled as one.

### 10.3 #3 Actual code checks (4 findings, all verified)

- **3.a** `src/ai/index.ts:17` — `TaskName = 'extract' | 'compose' | 'tools' |
  'judge'`. The task slot exists. **✓ VERIFIED**
- **3.b** `jobs.raw` holds the serialised `JobPosting`, which includes
  `description` as plain text (HTML stripped at the edge by `toPlainText`). So
  the judge needs no re-fetch and no parsing. **✓ VERIFIED**
- **3.c** `poll.ts` grouping is a synchronous block inside an async `pass()`, so
  an `await` for the judge fits without restructuring. **✓ VERIFIED**
- **3.d** `roleKey`/`roleCore`/`qualifierOf` are pure and exported, so reusing
  them as a candidate generator needs no change. **✓ VERIFIED**

### 10.4 #4 Security (3 findings, 1 actionable)

- **4.a** Job descriptions go to a model provider. They are public postings, so
  no new exposure — but the same table will later hold *contact* decisions,
  which name real people. **ACTIONABLE §3** — `decisions` lives in the same
  out-of-repo SQLite file as `contacts`, and this is stated in the schema
  comment so nobody later exports it for convenience.
- **4.b** `correction_note` is free text written by Mahi and fed back into a
  prompt. Prompt injection by the operator against himself is not a threat.
  **✓ ALIGNED**
- **4.c** No new dependency: `ai` and `zod` are already direct. **✓ ALIGNED**

### 10.5 #5 Vision alignment (2 findings, 0 actionable)

- **5.a** `vision.md`: *"a role worth pursuing, a named person who decides"*.
  This makes the role boundary a judgement rather than a regex, which is closer
  to the vision than v1.0. **✓ ALIGNED**
- **5.b** Cost prudence: cents per pass, and it *prevents* $0.14 lookups.
  **✓ ALIGNED**

### 10.6 #6 Architecture consistency (4 findings, 2 actionable)

- **6.a** `architecture.md` states **"Layer 0 — screening stays model-free"**.
  This puts a model adjacent to Layer 0. **ACTIONABLE §2** — the doc needs the
  distinction written into it: screening runs over 3,088 and stays free and
  auditable; grouping runs over the 38 that survived and is a judgement about
  sameness. Different volumes, different guarantees. Left unwritten, the next
  session reads a contradiction.
- **6.b** `poll.ts` stays the only orchestrator; the judge is a library.
  **✓ ALIGNED**
- **6.c** The judge is the first model call outside `src/agent/`. Placing it in
  `src/roles/` keeps it beside the concept it serves rather than centralising
  by technology. **✓ ALIGNED** with how `screen/` and `score/` are organised.
- **6.d** `decisions` overlaps conceptually with `gates`, which already records
  why a posting was rejected. **ACTIONABLE §3** — they are not merged: `gates`
  is per-posting per-rule and deterministic; `decisions` is per-judgement and
  carries a correction. Stated in the schema comment so the duplication reads
  as deliberate.

### 10.7 #7 Impact on other features (4 findings, 3 actionable)

- **7.a — state-machine sub-analysis, TRIGGERED.** Traffic into `variant`
  changes: judged grouping will produce *fewer* variants than the key, since
  unsure groups split.

  | state | producers | consumers | operator actions |
  |---|---|---|---|
  | `variant` | `poll.ts` grouping (judged, or key on fallback); `roles --backfill` | `queue.ts` lists under role; `status.ts` counts; `explain.ts` explains | `roles -- --split`, `queue -- --skip` |

  Parity: `--split` must promote a variant back to `scored` **and** record the
  correction. **ACTIONABLE §4.5** — one path, not two, or the correction gets
  skipped whenever someone is in a hurry.
- **7.b** `queue -- --skip` on a variant still writes `skipped`, which is
  correct and unaffected. **(no action)** — checked, not assumed.
- **7.c** A judged re-grouping on a later pass could move a posting whose role
  already has a recorded contact, orphaning it. **ACTIONABLE §7** — roles with
  a contact or a correction are never re-judged. Already implied by "a
  correction is final"; made explicit because it is the expensive failure.
- **7.d** `prepare-cases` selects by score over postings and will now see
  different representatives. **(no action)** — it was already going to change
  in v1.0 scope B; noted so the two do not collide.

### 10.8 #8 Test coverage (4 findings, 3 actionable)

- **8.a** The judge is a model call, so it cannot be unit-tested for judgement.
  **ACTIONABLE §8** — test the deterministic shell: partition validation
  (1.c), split-on-unsure (4.3), fallback on error (§5), retrieval assembly.
  The judgement itself is measured by the eval case set, not by a unit test.
- **8.b** Fixtures must use **the real Skydreams and Bjak descriptions**, not
  written ones. This has now bitten twice — the `headline` field that did not
  exist, and a Skydreams title I invented that made a test pass while the
  behaviour it claimed to protect was broken. **ACTIONABLE §8**
- **8.c** A test must prove the poll survives a judge that throws.
  **ACTIONABLE §8** — inject a failing judge and assert grouping still
  completes by key.
- **8.d** Baseline is 125 tests. **✓ VERIFIED**

### 10.9 #9 Deployment & rollback (3 findings, 2 actionable)

- **9.a** `decisions` is a new table; nothing reads it until written.
  Additive, and an older build ignores it. **✓ ALIGNED**
- **9.b** Rollback means grouping reverts to the key. Roles already judged keep
  their partition, which may differ from what the key would produce.
  **ACTIONABLE §8** — the rollback note is that this is *acceptable*: a judged
  partition is not corrupt, just not reproducible by the key. Say so, or
  someone will "fix" it by re-running the backfill and destroying corrections.
- **9.c** No env change; the provider comes from existing config.
  **ACTIONABLE §6** — `config.ai.tasks.judge` should be set explicitly rather
  than falling through to the default provider, so the judge's model is a
  visible decision.

### 10.10 #10 Risks (5 findings)

- **10.a** *The judge merges worse than the key.* Possible — models are
  agreeable and may accept a suggested grouping. **Mitigation:** step 2 is a
  dry run compared against the key before anything is wired in; and
  split-on-unsure biases against merging.
- **10.b** *Retrieval poisons later judgements.* One bad correction, retrieved
  forever, propagates. **Mitigation:** corrections are Mahi's own words and few;
  if this becomes real, corrections need a review pass. **Accepted, watched.**
- **10.c** *The corrections table becomes write-only.* Built, never read,
  never graded — the fate of most telemetry. **Mitigation:** step 6 makes it an
  eval case shape in the same plan rather than "later".
- **10.d** *This is a model where a rule would do.* If the six Bjak groups and
  the Skydreams split are all the judgement ever needed, a model is
  overkill. **Mitigation:** the funnel is about to widen from 2 companies to
  many; the two-company store is not the steady state. Worth re-asking after
  the first real discovery run.
- **10.e** *Scope.* Six files, a table, a model call and an eval shape.
  **Mitigation:** §8 sequences it so steps 1-3 answer the central unverified
  assumption (2.a) before anything is wired in.

### 10.11 Net v2.0 changes

| Finding | Section | Change |
|---|---|---|
| 1.a | §4.2 | cap at 12 postings shown; mark the decision `partial` |
| 1.b | §4.3 | mostly-empty descriptions cannot be confident, so they split |
| 1.c | §4.2 | validate the partition; malformed → split |
| 1.e | §6 | corrections key on role + qualifier, not job id |
| 1.f | §4.5 | `--split` on a single-posting role says so |
| 2.a | §8 | step 2 dry run verifies the central assumption first |
| 2.d | §5 | cost bound stated per *new* candidate group |
| 2.e | §8 | retrieval's benefit labelled as an untested bet |
| 4.a, 6.d | §3 | schema comments: out-of-repo, and why not merged with `gates` |
| 6.a | §2 | `architecture.md` needs the screening/grouping distinction written |
| 7.a | §4.5 | `--split` applies and records through one path |
| 7.c | §7 | roles with a contact or correction are never re-judged |
| 8.a-c | §8 | test the shell, real fixtures, prove poll survives judge failure |
| 9.b | §8 | rollback note: a judged partition is not corrupt |
| 9.c | §6 | set `config.ai.tasks.judge` explicitly |

### 10.12 Open for Mahi

- **[Mahi-verify] 2.a** — step 3: read the judge's grouping against the key's
  before it is wired in. If the descriptions do not separate Homedeal from
  Moving24, this plan is wrong and step 3 is where that shows.
- **10.d** — worth re-asking after the funnel widens: is this a model where a
  rule would do?
- **Scope** — steps 1-3 (substrate, judge, dry run), or all six?

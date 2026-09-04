# Plan v2.1 — establish a company's brands once, then group within them

**Draft, not ratified.** Stress-tested across all 10 dimensions of
`sop/stress-test-10-dimensions.md`; absorption notes in §9.

Amends `role-grouping-plan-v2.md` §4. Everything else in v2.0 stands — the
decisions substrate, the retry, the partition guard, split-on-unsure and the
confidence definition are all orthogonal to what changes here.

---

## 1. What v2.0 got wrong

v2.0 asked the model, once per candidate group, "are these one job?" Seven
groups, seven independent judgements. Reading them together (v2.0 §12):

| role | App | plain | judge said | consistent |
|---|---|---|---|---|
| product engineer | 0 | 4 | one role | ✓ |
| product owner, technical | 0 | 4 | one role | ✓ |
| technical product lead | 4 | 4 | splits on App | ✓ |
| technical product manager | 4 | 4 | splits on App | ✓ |
| **product lead** | **4** | **3** | **kept as one** | **✗** |
| **product manager** | **2** | **3** | splits, both sides mix | **✗** |

Four groups contain both of Bjak's brands. Two split on the brand boundary and
two did not, and one of the failures contradicts what the same model concluded
confidently minutes earlier.

**Which brands a company runs is a fact about the company.** Asking it once per
group derives Bjak's taxonomy six independent times from six overlapping slices
of evidence, and it lands differently. The model is not erratic; it is being
asked six unrelated questions and answering each locally.

This is the week's recurring shape: reading `headline` per source instead of
normalising once, inferring actor health from repeated emptiness instead of
reading the field that said so. **A fact that belongs in one place, derived in
many.**

## 2. The shape

Two passes. The first is a judgement made once per company; the second is
deterministic.

```
  postings at a company
        │
        ▼
  PASS 1  taxonomy          ONE model call per company
        │  "what brands or business units does this company run,
        │   and which does each listing belong to?"
        │  recorded as a decision, correctable, cached
        ▼
  PASS 2  grouping          NO model call
        │  role = company :: unit :: roleCore
        ▼
  roles
```

### 2.1 What this buys

**Consistency.** The taxonomy is derived once, so it cannot disagree with
itself. The two inconsistent groups above disappear by construction, not by a
better prompt.

**Fewer calls.** One per company, not one per candidate group — six calls
become one on the current store, and the ratio widens as a company posts more
roles.

**Cheaper corrections.** Telling the system *"BJAK and KIRA are different
brands"* fixes every group at Bjak at once. Under v2.0 the same correction had
to be learned six times, and retrieval would have been fighting six independent
derivations.

**A smaller question.** "Which brand is this listing?" is answerable from the
boilerplate at the top of a description. "Are these the same job?" required
holding a whole comparison in view.

### 2.2 What it costs

Grouping stops being a judgement and becomes a consequence of one. If the
taxonomy is wrong, every role at that company is wrong together rather than
wrong in scattered places. That is a real trade: **one correctable failure
instead of six independent ones.** Given that a correction now fixes a company
rather than a group, this is the better direction — but it is a trade, not a
free win.

## 3. Pass 1 — the taxonomy

### 3.1 What the model is shown

**Sampled by distinct qualifier, not by posting.** Bjak has 38 live listings
and about 8 distinct qualifiers; showing one description excerpt per distinct
qualifier is the same evidence at a fifth of the tokens, and it scales to a
company with 300 postings where showing all of them would not.

For each distinct qualifier: the qualifier, one example title, and the first
~800 characters of one description carrying it.

### 3.2 What it returns

```ts
{
  units: [{ name: string, description: string, evidence: string }],
  assignment: [{ qualifier: string, unit: string }],
}
```

`units` may be a single entry, and usually will be — most companies run one
brand, and the taxonomy pass is then a cheap confirmation rather than a split.

### 3.3 When it runs, and when it does not

Cached on the company. Re-derived only when a posting appears whose qualifier
is not in `assignment` — that is the only event that can change the answer.

**A single-unit taxonomy is still recorded.** Otherwise the absence of a row
means both "not yet asked" and "asked, one brand", and those need different
handling on the next pass.

### 3.4 When it is unsure

Same rule as v2.0 §4.3, and for the same reason: **when unsure, split.** A
qualifier the model cannot confidently assign gets its own unit. That
over-splits, which costs a duplicate queue entry you can see, rather than
merging two brands, which hides a job you never learn about.

## 4. Pass 2 — grouping, deterministic again

```
role_id = `${company}::${unit}::${roleCore(title)}`
```

No model call. `roleKey`, `roleCore` and `qualifierOf` are unchanged; the unit
is inserted between company and role core.

A company with one unit produces exactly today's behaviour, so the change is
inert where it should be.

### 4.1 The residual judgement, deliberately not built

Two listings in the same unit with the same role core could still be two jobs —
"Product Manager, Growth" and "Product Manager, Retention" at one brand may be
two teams. v2.0's per-group judge would have caught that; this does not.

**Not built, for two reasons.** It has not happened once in the observed data —
every mixed group so far divided on brand, not on function. And building the
escape hatch before seeing the failure is precisely the mistake avoided when
scope A shipped without `--split`, which is how the Skydreams merge got found
rather than guessed at.

Recorded here so that when it does happen, it is recognised rather than
rediscovered.

## 5. Changes

| File | Change |
|---|---|
| `src/store/db.ts` | `company_units` table; `roles.unit`; `taxonomyFor()`, `saveTaxonomy()`; `'taxonomy'` decision kind |
| `src/roles/taxonomy.ts` | **new.** Pass 1: sampling, prompt, schema, retry, split-on-unsure |
| `src/roles/key.ts` | `roleKey(company, unit, title)` — one parameter, no logic change |
| `src/roles.ts` | `--taxonomy` dry run; taxonomy shown in `npm run roles`; backfill re-groups with units |
| `src/poll.ts` | taxonomy before grouping, cached; falls back to a single unit on error |
| `src/roles/judge.ts` | **kept**, unused by the default path. §4.1 is where it returns |

## 6. What this does not do

- **No training.** Unchanged from v2.0 §7.
- **No SLM.** `modelForTask(config, 'judge')`, still a config switch.
- **No residual same-unit judgement.** §4.1.
- **No cross-company merging.** Two companies with a shared parent stay two.

## 7. Sequence

1. `company_units` + `roles.unit` + the taxonomy decision kind, with tests
2. `taxonomy.ts` and `npm run roles -- --taxonomy`, dry run, writing nothing
3. Read Bjak's and Skydreams' taxonomies — **[Mahi-verify]**
4. `roleKey` takes a unit; re-backfill; confirm Bjak splits into BJAK and KIRA
   consistently across all six role levels
5. Wire pass 1 into `poll.ts` behind the single-unit fallback
6. `--correct` on a taxonomy, and retrieval of taxonomy corrections

## 8. Done when

- Bjak's six role levels all divide on the same brand boundary, or none do
- Skydreams gives two units, Homedeal and Moving24
- A company with one brand groups exactly as it does today
- One taxonomy correction changes every role at that company
- The taxonomy call failing leaves grouping working and the poll running
- Test count rises; `npm run typecheck` clean

---

## 9. v2.1 10-dimension stress-test absorption notes

### 9.1 #1 Edge cases (7 findings, 6 actionable)

- **1.a** A company with 300 distinct qualifiers still blows the prompt even
  after sampling. **ACTIONABLE §3.1** — cap at 40 distinct qualifiers; beyond
  that, take the 40 most frequent and assign the tail to the nearest unit by
  exact qualifier match, marking the taxonomy `partial`.
- **1.b** A posting with no qualifier at all (`Technical Product Manager`, seen
  in the live data) has nothing to assign on. **ACTIONABLE §3.2** — the empty
  qualifier is a legitimate key and must be assignable; the judge sees it as
  `(no qualifier)` and it usually belongs to the parent brand.
- **1.c** Two units could be returned with the same name, or a name that is
  empty. **ACTIONABLE §3.2** — validate: names non-empty, unique after
  case-folding, and every qualifier assigned to a name that exists. On failure,
  retry once then fall back to a single unit.
- **1.d** A unit name containing `::` would corrupt the role id.
  **ACTIONABLE §4** — slugify the unit into the id, keep the display name in
  `company_units`. The same applies to a company name containing `::`, which
  v1.0 never guarded either.
- **1.e** A qualifier appearing after the taxonomy was cached triggers
  re-derivation, which may rename or merge existing units and orphan roles.
  **ACTIONABLE §3.3** — re-derivation is additive only: existing units keep
  their names and assignments, and the new qualifier is assigned among them or
  creates a new unit. A full re-derivation is a manual act.
- **1.f** Company names differing by case or whitespace ("Bjak", "bjak ") would
  create two taxonomies. **ACTIONABLE §5** — key the taxonomy on the same
  normalised company string `roleKey` already uses.
- **1.g** A company with exactly one live posting. **(no action)** — one unit,
  one role, correct and cheap.

### 9.2 #2 Unverified assumptions (5 findings, 3 actionable)

- **2.a** *"The taxonomy is derivable from one description excerpt per
  qualifier."* Strongly suggested — the model already named KIRA and BJAK from
  boilerplate, confidently, three times out of four. **NOT PROVEN at 800 chars
  sampled once per qualifier.** **ACTIONABLE §7** — step 2 is a dry run for
  exactly this, and step 3 is the gate. If the excerpt is too short, that is
  where it shows.
- **2.b** *"Most companies run one brand."* Assumed from two companies of
  evidence, one of which has two brands and the other of which also has two.
  **The observed rate is 2 of 2.** **ACTIONABLE §2.1** — do not claim the
  single-unit path is the common case until the funnel widens; it is the
  *inert* case, which is the property that matters.
- **2.c** *"Grouping becomes deterministic."* True only if the taxonomy covers
  every qualifier. **ACTIONABLE §4** — an unassigned qualifier must have a
  defined behaviour: it gets its own unit, per §3.4, rather than silently
  joining the parent.
- **2.d** *"`roleKey` gains a parameter with no logic change."* Verified by
  reading `src/roles/key.ts` — the company is only lowercased and collapsed
  before the `::`, so a second segment inserts cleanly. **✓ VERIFIED**
- **2.e** *"The `decisions` table can carry a taxonomy."* Verified: `kind` is a
  free string in the schema and `DecisionKind` is a union in TypeScript only,
  so adding `'taxonomy'` is a type change with no migration. **✓ VERIFIED**

### 9.3 #3 Actual code checks (5 findings, all verified)

- **3.a** `src/roles/key.ts` — `roleKey` is `${collapse(company).toLowerCase()}::${roleCore(title).toLowerCase()}`.
  Inserting a unit is mechanical. **✓ VERIFIED**
- **3.b** `roles.id` is the role key and the primary key, and `postingsInRole`
  joins on it. Changing the key's shape changes every existing id, so the
  backfill must run. **✓ VERIFIED**, and it is why step 4 includes a re-backfill.
- **3.c** `src/store/db.ts` `addColumn()` exists and is guarded, so `roles.unit`
  is additive on an existing database. **✓ VERIFIED**
- **3.d** `poll.ts` groups inside an async `pass()`, so an awaited taxonomy call
  fits without restructuring — same finding as v2.0 3.c, re-checked rather than
  inherited. **✓ VERIFIED**
- **3.e** `src/roles/judge.ts` is not imported by `poll.ts` today (only by
  `roles.ts --judge`), so keeping it unused by the default path costs nothing.
  **✓ VERIFIED**

### 9.4 #4 Security (3 findings, 0 actionable)

- **4.a** Job descriptions go to a model provider; they are public postings.
  Unchanged from v2.0. **✓ ALIGNED**
- **4.b** `company_units` holds company and brand names — no personal data.
  **✓ ALIGNED**
- **4.c** No new dependency. **✓ ALIGNED**

### 9.5 #5 Vision alignment (2 findings, 0 actionable)

- **5.a** `vision.md` — *"a role worth pursuing, a named person who decides"*.
  A brand boundary is precisely where "who decides" changes, so this makes the
  role boundary track the thing the vision cares about. **✓ ALIGNED**
- **5.b** Cost: fewer model calls than v2.0 and strictly fewer paid contact
  lookups than v1.0. **✓ ALIGNED**

### 9.6 #6 Architecture consistency (4 findings, 2 actionable)

- **6.a** v2.0 finding 6.a is still outstanding: `architecture.md` says
  "screening stays model-free" and this puts a model earlier in the pipeline
  than v2.0 did, not later. **ACTIONABLE §5** — the doc edit is now overdue and
  ships with this, not after it.
- **6.b** Grouping returns to being deterministic, which restores the property
  that made Layer 0 auditable. The judgement is isolated in one call whose
  output is stored and readable. **✓ ALIGNED** — arguably more consistent with
  the repo's shape than v2.0 was.
- **6.c** `src/roles/taxonomy.ts` beside `src/roles/key.ts` keeps the concept
  together. **✓ ALIGNED**
- **6.d** Two model-calling modules would now exist in `src/roles/`, one of them
  unused by default. **ACTIONABLE §5** — say plainly in `judge.ts` that it is
  retained for §4.1 and is not on the default path, or the next session deletes
  it as dead code or wires it back in by accident.

### 9.7 #7 Impact on other features (5 findings, 4 actionable)

- **7.a — state-machine sub-analysis, TRIGGERED.** Role ids change shape, so
  every posting's `role_id` changes and `variant` membership is recomputed.

  | state | producers | consumers | operator actions |
  |---|---|---|---|
  | `variant` | `poll.ts` grouping; `roles --backfill` | `queue.ts`, `status.ts`, `explain.ts` | `queue -- --skip` |

  Parity risk: a posting currently `variant` may become a representative under
  the new taxonomy, and vice versa. **ACTIONABLE §7** — the re-backfill must
  promote and demote in one pass, and must not touch `sent` or `queued`, which
  it already respects.
- **7.b** `contacts.role_id` was added in scope A and would point at old-shaped
  role ids. **ACTIONABLE §7** — remap during the re-backfill, or a contact
  detaches from its role silently. This is the expensive failure: a contact is
  a paid artefact.
- **7.c** Corrections recorded against v2.0-shaped role ids stop matching the
  `subject LIKE 'company::%'` prefix used by `correctionsFor`. **(no action)** —
  the prefix is the company segment, which is unchanged. Checked rather than
  assumed.
- **7.d** `explain.ts` prints the role title; it must not print a slugified unit
  where a human expects a brand name. **ACTIONABLE §5** — display name from
  `company_units`, never the slug.
- **7.e** `prepare-cases` selects by score over postings and inherits whatever
  grouping exists. **(no action)** — unchanged, and still pending v1.0 scope B.

### 9.8 #8 Test coverage (4 findings, 3 actionable)

- **8.a** The taxonomy call cannot be unit-tested for judgement. Test the shell:
  sampling by distinct qualifier, validation (1.c), slugification (1.d),
  additive re-derivation (1.e), fallback to a single unit.
  **ACTIONABLE §7**
- **8.b** Fixtures use the real Bjak and Skydreams data. Twice now an invented
  fixture has passed while the real behaviour was broken — a `headline` field
  that did not exist, and a Skydreams title I made up. **ACTIONABLE §7**
- **8.c** A test must prove `roleKey` with a single unit reproduces today's
  grouping exactly, so the inert case is provably inert. **ACTIONABLE §7**
- **8.d** Baseline 154 tests. **✓ VERIFIED**

### 9.9 #9 Deployment & rollback (4 findings, 3 actionable)

- **9.a** `company_units` is new and `roles.unit` is additive.
  **✓ ALIGNED**
- **9.b** Role ids change, so this is not a clean revert: rolling back leaves
  three-segment ids in `roles` and on `jobs.role_id`. **ACTIONABLE §7** — the
  rollback is `npm run roles -- --backfill` on the reverted code, which
  recomputes two-segment ids. State that, or someone will hand-edit the store.
- **9.c** The re-backfill is destructive to existing groupings, which may
  include ones Mahi has already read and accepted. **ACTIONABLE §7** — snapshot
  `id, state, role_id` before it runs, as was done for scope A.
- **9.d** `config.ai.tasks.judge` covers this call too; no new config key.
  **ACTIONABLE §5** — reuse rather than adding `tasks.taxonomy`, since the two
  never need different providers and an unused knob is a lie.

### 9.10 #10 Risks (5 findings)

- **10.a** *A wrong taxonomy is wrong everywhere at that company.* The trade in
  §2.2, stated as a risk rather than buried. **Blast radius: one company.
  Mitigation:** step 3 reads it before anything is wired in, and one correction
  fixes all of it.
- **10.b** *The model invents brands that do not exist* — splitting a single
  product line into imagined units. **Mitigation:** `evidence` is required per
  unit, so an invented unit has to cite text; and §3.4 only over-splits, which
  is the visible direction.
- **10.c** *Brands are the wrong axis.* Some companies divide by region or
  customer segment, not brand. **Mitigation:** the prompt asks for "brands or
  business units", and the field is `units` rather than `brands`. Worth
  re-asking once the funnel has more than two companies in it.
- **10.d** *v2.0's judge rots.* Kept, unused, untested against reality until
  §4.1 arrives. **Mitigation:** its unit tests still run; and 6.d requires the
  reason for keeping it to be written where it lives.
- **10.e** *This is the second redesign of grouping in one day.* Real risk of
  over-engineering a problem that two companies of data cannot justify.
  **Mitigation:** the evidence is not speculative — two of two companies run
  multiple brands, and the inconsistency is measured, not feared. But **10.c
  and 2.b both say the same thing: re-examine after the funnel widens.**

### 9.11 Net v2.1 changes

| Finding | Section | Change |
|---|---|---|
| 1.a | §3.1 | cap at 40 distinct qualifiers; tail by exact match; mark `partial` |
| 1.b | §3.2 | the empty qualifier is assignable |
| 1.c | §3.2 | validate names and assignments; retry once; fall back to one unit |
| 1.d | §4 | slugify units into the id, display name kept separately |
| 1.e | §3.3 | re-derivation is additive only |
| 1.f | §5 | taxonomy keyed on the normalised company string |
| 2.a | §7 | step 2 dry run, step 3 gate, before anything is wired |
| 2.b | §2.1 | single-unit is the *inert* case, not the claimed common one |
| 2.c | §4 | an unassigned qualifier gets its own unit |
| 6.a | §5 | the `architecture.md` edit ships with this, not after |
| 6.d | §5 | `judge.ts` says why it is retained and off the default path |
| 7.a, 7.b | §7 | re-backfill promotes/demotes in one pass and remaps `contacts.role_id` |
| 7.d | §5 | display names, never slugs, in operator output |
| 8.a-c | §7 | shell tests, real fixtures, and a proof the one-unit case is inert |
| 9.b, 9.c | §7 | rollback is a re-backfill; snapshot before running |
| 9.d | §5 | reuse `tasks.judge`; no new config key |

### 9.12 Open for Mahi

- **[Mahi-verify] 2.a** — step 3: read Bjak's and Skydreams' taxonomies before
  anything is wired in. If one description excerpt per qualifier is not enough
  to see the brands, this is where it shows.
- **10.c / 2.b** — re-examine the "brands or business units" axis once the
  funnel has more than two companies. Both findings point at the same
  two-companies-of-evidence problem.
- **10.e** — is a second redesign of grouping in one day warranted? The
  inconsistency is measured rather than feared, but it is a fair question.
- **Scope** — steps 1-3 (schema, taxonomy, dry run), or through step 4
  (re-backfill and confirm Bjak divides consistently)?

---

## 10. Step 3 dry run — results (2026-09-04)

**Two model calls, one per company. Both assumptions hold.**

### 10.1 Bjak

```
  Bjak — 48 listing(s) ... 2 unit(s)
      BJAK  —  The core BJAK company — Southeast Asia's leading insurance
               platform, expanding into spending, saving, investing and more.
        evidence: "ABOUT BJAK The original mission of BJAK is we believe people
                   deserve smarter ways to plan, save and grow their..."
        AI Investing, AI Finance, AI Stockbroking, AI Neobank, (no qualifier)

      KIRA  —  AI-focused consumer money app brand, described with its own
               mission statement.
        evidence: "About KIRA Our mission is to make money smart, reliable and
                   within reach for everyone... We believe AI will he..."
        AI Neobank App, AI Stockbroking App, AI Finance App, AI Investing App

      -> 10 role(s) under this taxonomy
```

Every plain qualifier to BJAK, every `App` qualifier to KIRA, **with no
exceptions** — and the evidence is the literal boilerplate paragraph, quoted,
which is exactly what §3.1 assumed one 800-character excerpt would expose.

### 10.2 Skydreams

```
  Skydreams — 2 listing(s) ... 2 unit(s)
      Homedeal  —  marketplace brand for home craft/renovation professionals
        evidence: "Our Homedeal brand is dedicated to uplifting the power of
                   the craft..."
      Moving24  —  moving company marketplace brand, present in 19 markets
        evidence: "our Moving24 brand is one of the leaders in moving company
                   marketplaces..."
      -> 2 role(s)
```

**Finding 2.a: VERIFIED.** One excerpt per qualifier is enough.

### 10.3 The consistency the whole redesign was for

Bjak's six role cores, and how many units each spans:

```
  product engineer             BJAK          -> 1
  product lead                 BJAK + KIRA   -> 2
  product manager              BJAK + KIRA   -> 2
  product owner, technical     BJAK          -> 1
  technical product lead       BJAK + KIRA   -> 2
  technical product manager    BJAK + KIRA   -> 2
                                                10
```

Two cores carry only plain qualifiers, so they are BJAK-only — matching the
0-App counts measured in v2.0 §12.1. The four that contain both brands now all
divide on the same boundary. **The v2.0 inconsistency is gone by construction
rather than by persuasion:** there is no second derivation available to
disagree with the first.

### 10.4 Three designs, on the same data

| | roles | Skydreams | Bjak's mixed groups | model calls |
|---|---|---|---|---|
| v1.0 string key | 7 | **merged, wrongly** | all merged, wrongly | 0 |
| v2.0 per-group judge | 11 | split correctly | **2 of 4 wrong** | 7 |
| **v2.1 taxonomy** | **12** | **split correctly** | **4 of 4 consistent** | **2** |

Fewer calls than v2.0 and a better answer. The saving is structural rather than
lucky: one company-level question replaces one question per candidate group,
and the ratio widens as a company posts more roles.

### 10.5 Verdict

Steps 1-3 are done and the gate passes. Step 4 — `roleKey` taking a unit, the
re-backfill, and confirming the split lands in the store — is unblocked, with
findings 7.a and 7.b (promote/demote in one pass, remap `contacts.role_id`) as
the parts to get right.

Cost: two calls, roughly thirty cents. v2.0 spent about two dollars across two
dry runs to reach a worse answer.

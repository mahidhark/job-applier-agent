# Sprint 1 plan — make the experiment answerable

*Draft v1.0. Not ratified. Stress-tested across all 10 dimensions per
`sop/stress-test-10-dimensions.md`; absorption notes in §6.*

## 1. Goal

Two outcomes, both prerequisites for everything else:

1. **The SLM question gets a real answer.** Today's qwen result says nothing
   about qwen — the prompt was 3.2× its context window.
2. **Outcomes start being recorded.** Nothing in either repo has ever captured
   whether an application or a message led anywhere. This is worthless
   retroactively.

Explicitly out of scope: drafting notes, semantic retrieval, any send path.

## 2. Work

### 2.1 Fit the prompt (blocks everything about the SLM)

**Measured:** 7 tools × ~5,800 chars = 40,750 chars of schema. Plus system
(2,064) and job description (3,000) ≈ 13,090 tokens. Ollama's default
`num_ctx` is 4,096. The prompt is silently truncated, which is why qwen made
zero tool calls in 308s.

- `src/ai/ollama.ts` and `src/agent/model.ts`: set `num_ctx` explicitly from
  config rather than inheriting a default nobody chose.
- `config/default.json`: `ai.ollama.numCtx`, default 16384.
- `config/connections.json`: a `minimal` tool profile — the three named actors
  only. `get-actor-run`, `abort-actor-run` and `get-key-value-store-record` are
  run-management the goal never needs; dropping them removes ~17,600 chars.
- `src/agent/run.ts`: log measured prompt tokens per step from the provider's
  usage, so "did it fit" stops being an inference.

**Done when:** `npm run agent -- --provider ollama --tools minimal <id>`
completes without a timeout and its first step reports a prompt that fits.
A wrong answer is a valid result; a truncated prompt is not.

### 2.2 Outcome capture

- `src/store/db.ts`: an `outcomes` table — `job_id`, `contact_url`, `channel`,
  `sent_at`, `accepted_at`, `replied_at`, `outcome`, `note`.
- `src/queue.ts`: `--sent`, `--accepted`, `--replied`, `--rejected <id>`.
- `npm run status`: acceptance and reply rate over the trailing 30 days, and
  the count of contacts sent with no terminal state yet.

**Done when:** a contact can be moved through sent → accepted → replied from
the CLI, and `status` reports rates rather than raw counts.

### 2.3 Source liveness alarm

A board whose slug rotates returns zero postings and says nothing. Skydreams
has 4 postings; a silent drop to 0 is indistinguishable from a quiet week.

- `src/store/db.ts`: record per-source posting counts per pass.
- `npm run status`: flag any source returning zero on three consecutive passes.

**Done when:** a source at zero for three passes is visible in `status`.

## 3. Tests

Baseline **42**; target **~56**.

- `grounding.test.ts` — already 9, unchanged.
- `outcomes.test.ts` (new, ~6): state transitions, idempotent marking, rate
  arithmetic with zero denominators, a contact marked replied without ever
  being sent.
- `connections.test.ts` (+2): the `minimal` profile resolves; an unknown
  profile is still reported rather than defaulted.
- `sources/liveness.test.ts` (new, ~4): three consecutive zeros flags, two does
  not, a source that recovers clears.

Not unit-tested, deliberately: the Ollama context fix. It is a live-behaviour
question and the acceptance criterion is a real run.

## 4. Sequence

1. `git checkout -b feat/sprint-01`
2. §2.1 context fix, then one live qwen run — it gates the rest of the sprint's
   value
3. §2.2 outcome capture
4. §2.3 liveness
5. `npm test`, `npm run typecheck`
6. journal entry in the same commit; push

## 5. Risks accepted

- **qwen may still fail after the fix.** That is the point; it would then be a
  finding about the model rather than about the harness.
- **16k context on CPU is slow.** Prompt evaluation grows with context, so a
  fitting prompt may take minutes. Acceptable — Mahi has said slow is fine —
  but it means the SLM's viability may turn on latency rather than quality, and
  the run harness must record wall time per step so that is visible.
- **Outcome data will be sparse for months.** Recording it now is still correct;
  the alternative is having none when it finally matters.

---

## 6. v1.0 10-dimension stress-test absorption notes

All 10 walked per `sop/stress-test-10-dimensions.md`. 24 findings, 9 actionable.
Three change the plan materially and are listed first in §6.11.

### 6.1 #1 Edge cases (6 findings, 3 actionable)

- 1.a: raising `num_ctx` to 16384 grows the KV cache. The box has ~3GB free and
  the model is ~2GB. **ACTIONABLE §2.1** — measure resident memory during the
  first long run; if it swaps, the SLM's viability is a memory question, not a
  reasoning one, and that must not be misreported as the model failing.
- 1.b: a contact marked `replied` that was never marked `sent`. **(no action)** —
  covered by the planned outcomes tests.
- 1.c: acceptance rate with a zero denominator. **(no action)** — same.
- 1.d: a board can legitimately return zero — a small company with everything
  filled. Three zeros would false-alarm. **ACTIONABLE §2.3** — record *fetched
  zero* separately from *errored*, and only alarm on a source that previously
  returned postings and now returns none.
- 1.e: the same person surfacing for two different roles at one company.
  **(no action)** — outcomes key on (job_id, contact_url).
- 1.f: §2.1 says to log prompt tokens "from the provider's usage". Ollama
  returns `prompt_eval_count`, but whether `ollama-ai-provider-v2` surfaces it
  through the AI SDK's usage object is unverified. **ACTIONABLE §2.1** — if it
  does not, read it from `/api/chat` directly rather than inferring.

### 6.2 #2 Unverified assumptions (5 findings, 3 actionable)

- 2.a: **the plan named the wrong file.** §2.1 said to set `num_ctx` in
  `src/ai/ollama.ts`. Verified at `src/agent/model.ts:15-23`: the Mastra agent
  goes through `createOllama` from `ollama-ai-provider-v2`, and never touches
  `src/ai/ollama.ts` at all. That fix would have changed nothing and the run
  would have failed identically. **ACTIONABLE §2.1** — the reliable route is an
  Ollama Modelfile (`PARAMETER num_ctx 16384`, `ollama create qwen2.5-16k`)
  referenced by name from config, which sidesteps provider option plumbing
  entirely. Passing `providerOptions` through the AI SDK is the alternative and
  must be verified before being relied on.
- 2.b: "dropping run-management tools removes ~17,600 chars" — recomputed from
  the measured sizes: get-actor-run 6,076 + get-key-value-store-record 5,832 +
  abort-actor-run 5,753 = 17,661, keeping `get-dataset-items` which the goal
  does need. **✓ VERIFIED.**
- 2.c: **16384 was sized against the FIRST request only.** Every tool result is
  appended to the conversation, and dataset reads are large — the Claude run
  accumulated 127,293 characters of tool output. By step six a 16k window
  overflows regardless of how well the first prompt fit. **ACTIONABLE §2.1** —
  the run harness must log context size per step, and the plan must treat
  mid-run overflow as the likelier failure than the initial prompt.
- 2.d: test baseline 42. **✓ VERIFIED** by `npm test`.
- 2.e: `JOB_STATES` already contains `sent`. **✓ VERIFIED** at db.ts.

### 6.3 #3 Actual code checks (4 findings, 1 actionable)

- 3.a: `src/agent/model.ts` uses the AI SDK provider — the source of 2.a.
  **ACTIONABLE**, folded into 2.a.
- 3.b: `src/queue.ts` already parses `--sent` and `--skip`; adding flags is
  additive. **✓ VERIFIED.**
- 3.c: `db.ts` has jobs, gates, contacts, drafts, spend — no outcomes table.
  **✓ VERIFIED.**
- 3.d: `setState` accepts the `JobState` union, which includes `sent`.
  **✓ VERIFIED.**

### 6.4 #4 Security (3 findings, 1 actionable)

- 4.a: the outcomes table stores named third parties and their profile URLs in
  local SQLite. Outside the repo and gitignored, so nothing is published.
  **ACTIONABLE §2.2** — state in the schema comment that this is personal data
  about people who did not consent to being in a database, and that it must not
  be exported or committed.
- 4.b: no new dependencies, no secrets, no network surface added. **(no action)**
- 4.c: nothing in this sprint can send. **(no action)**

### 6.5 #5 Vision alignment (2 findings, 0 actionable)

- 5.a: outcome capture serves the vision's stated intolerable outcome — "the
  unacceptable result is not knowing". **✓ ALIGNED.**
- 5.b: no send path is added or made easier. **✓ ALIGNED.**

### 6.6 #6 Architecture consistency (2 findings, 0 actionable)

- 6.a: outcomes belong in `store/db.ts` beside contacts, not a new module.
  **✓ ALIGNED.**
- 6.b: liveness is per-source counting, which is store state, not source
  behaviour — it goes in db.ts, and adapters stay pure. **✓ ALIGNED.**

### 6.7 #7 Impact on other features (2 findings, 1 actionable)

- 7.a: **state-machine sub-analysis, triggered.** This adds outcome states while
  `jobs.state` already has `sent`. Two state machines over the same idea is
  exactly the drift the SOP warns about — a job could read `sent` while its
  contact has no outcome row, or the reverse. Producers: `queue.ts` only.
  Service consumers: `status.ts`, `explain.ts`. UI affordances: the CLI flags.
  Parity holds only if one is authoritative. **ACTIONABLE §2.2** — `jobs.state`
  stops at `queued`; everything after contact lives in `outcomes`, and
  `queue.ts` writes one or the other, never both.
- 7.b: `num_ctx` affects only the ollama path; Claude runs are untouched.
  **(no action)**

### 6.8 #8 Test coverage (3 findings, 1 actionable)

- 8.a: the context fix has no unit test; acceptance is a live run. Stated in
  §3 rather than implied. **(no action)**
- 8.b: nothing exercises the provider option plumbing, which 2.a shows is the
  fragile part. **ACTIONABLE §3** — a smoke check that the configured model name
  reaches Ollama and reports the context it was given.
- 8.c: liveness needs a test for *recovery*, not just detection. **(no action)** —
  already in the planned cases.

### 6.9 #9 Deployment & rollback (2 findings, 1 actionable)

- 9.a: nothing in this repo runs under pm2 yet, so there is no live blast
  radius and rollback is `git revert` on an unmerged branch. **(no action)**
- 9.b: a Modelfile-derived model is state on the box that is not in the repo and
  will not exist on a rebuild. **ACTIONABLE §2.1** — commit the Modelfile and
  the `ollama create` command to the README, or the next machine silently falls
  back to a 4,096 context and reproduces today's failure.

### 6.10 #10 Risks (2 findings, 1 Mahi-verify)

- 10.a: memory. Covered by 1.a. **Accepted, measured rather than assumed.**
- 10.b: if the SLM only works at a context size the box cannot hold, the honest
  conclusion is "not on this hardware" rather than "not possible".
  **[Mahi-verify]** — is a GPU box in scope if CPU proves to be the binding
  constraint? It changes what a negative result means.

### 6.11 Net v1.0 changes

| Finding | Section | Change |
|---|---|---|
| 2.a / 3.a | §2.1 | Fix targets the wrong file. Use an Ollama Modelfile, referenced by name; verify providerOptions before relying on it |
| 2.c | §2.1 | Size context for the whole conversation, not the first request; log context per step; expect mid-run overflow first |
| 7.a | §2.2 | `jobs.state` stops at `queued`; outcomes own everything after contact. One authority, not two |
| 1.a / 10.a | §2.1 | Measure resident memory during the long run; a memory ceiling must not be reported as a reasoning failure |
| 1.d | §2.3 | Distinguish fetched-zero from errored; only alarm on a source that used to return postings |
| 1.f | §2.1 | Verify the AI SDK surfaces `prompt_eval_count`; read `/api/chat` directly if not |
| 4.a | §2.2 | Schema comment: third-party personal data, never exported or committed |
| 8.b | §3 | Smoke check that the configured model and context actually reach Ollama |
| 9.b | §2.1 | Commit the Modelfile and its create command, or a rebuild silently regresses |

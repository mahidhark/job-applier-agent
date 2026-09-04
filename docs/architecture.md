# Architecture

The system finds full-time roles worth pursuing, works out who to talk to, and
drafts the outreach. It stops one step before contact. Everything below is what
exists or is planned; measurements cited are from live runs on 2026-09-04.

## Shape

```
LAYER 0  DISCOVERY & SCREENING           deterministic, no model
         Ashby / Greenhouse / Lever      official JSON APIs, free
         Apify LinkedIn jobs             paid, runs behind the gates
              │
              ▼  gates.ts (pure) ──▶ score.ts ──▶ SQLite
              │  3,088 postings in, 38 out
              ▼
LAYER 0b GROUPING           taxonomy: 1 model call per company, cached
              │             then role = company::unit::roleCore, no model
              │             38 postings ──▶ 12 roles across 4 business units
              ▼
LAYER 1  INFERENCE          Vercel AI SDK: anthropic | cerebras | ollama
              │             chosen per task, not globally
              ▼
LAYER 2  TOOLS              Mastra createTool over Apify MCP
              │             wrapped, never raw call-actor
              ▼
LAYER 3  AGENT              Mastra Agent — a goal, a step ceiling, a budget
              │
              ▼
LAYER 4  EVAL               cases · scorers · gates · trajectory · judge
              │
              ▼
LAYER 5  QUEUE              contact + note + why  ──▶  a human sends
```

## Layer 0 — screening stays model-free

3,088 postings are judged by pure functions in under a second, and every
rejection records which gate fired and why, so `npm run explain <id>` can answer
for any posting later. An LLM here would be unaffordable and unauditable.

Three bugs were found in one afternoon by reading gate output. None would have
been visible if a model had made those calls.

**Grouping is not screening, and it does use a model.** The distinction is
volume and reversibility. Screening runs over every posting ever seen and must
stay free and auditable. Grouping runs over the ~38 that survived, and asks a
question no rule can answer: are these eight listings one job or two? Bjak
advertises the same title under two brands, BJAK and KIRA, and the only thing
that separates them is the boilerplate paragraph in the description.

The judgement is made **once per company**, not once per group. Which brands a
company runs is a fact about the company; deriving it per group produced six
independent answers for Bjak that disagreed with each other. So:

```
  taxonomy   one model call per company, cached in `company_units`, correctable
      │
      ▼
  grouping   NO model call.  role = company :: unit :: roleCore
```

The poll only ever **reads** the stored taxonomy. A company with none recorded
gets a single unit, which reproduces the pre-taxonomy grouping exactly — so an
unattended run can neither be blocked nor billed by this, and deriving a
taxonomy stays a deliberate act (`npm run roles -- --learn`).

Measured on the current store: 38 live postings, 12 roles across four business
units. A string key alone gave 7, merging Skydreams' two brands into one and
hiding four Bjak roles behind four others.

## Layer 2 — the tool surface is the load-bearing decision

**Measured.** Given Apify's raw MCP surface, `gpt-oss-120b` spent all twenty
steps making eighteen consecutive profile searches and never once read a
result. Apify's pattern is *call actor → get datasetId → call get-dataset-items*,
which asks the model to manage an async job lifecycle. From its side nothing
ever came back, so it kept rephrasing the query.

| surface | tool calls | wall time | behaviour |
|---|---|---|---|
| raw Apify MCP | 20 (ceiling) | 224.6s | never read a result |
| wrapped tools | 5 | 59.5s | resolve, search, refine, refine |

A 120B model failed on the raw surface. A 4B has no chance, so **fixing the
surface precedes any local-model work** rather than following it.

Five tools, each wrapping one actor with a fixed name, a small schema and a
declared price:

| tool | source | cost |
|---|---|---|
| `resolve_company` | harvestapi/linkedin-company | $0.005 |
| `find_people_at_company` | harvestapi/linkedin-profile-search | $0.10 |
| `find_employees_at_company` | harvestapi/linkedin-company-employees | $0.05 |
| `read_recent_posts` | harvestapi/linkedin-profile-posts | $0.02 |
| `record_contact` | — commits a person | $0 |
| `record_no_contact` | — commits that nobody is reachable | $0 |

Those are **Free/Bronze-tier prices**. Apify's Store discount tier comes with
the subscription plan — Free and Starter both sit at Bronze pricing for these
actors, Scale reaches Silver ($0.08 / $0.006) and Business Gold ($0.05 /
$0.004). At this project's volume the discount never pays for the plan: Scale
costs $180/month more and would need roughly nine hundred enrichment runs a
month to break even. Starter exists here to clear the free-plan run cap, not to
buy a discount.

Two sources answer the same question deliberately. On 2026-09-04
`linkedin-profile-search` returned zero rows for every company including
Booking.com, having worked three hours earlier.

**That was diagnosed wrong, and the correction matters more than the incident.**
It was recorded as an upstream outage, and `actorHealth()` was built to infer
degradation from repeated emptiness. Later the same day a run record read:

```json
{"status":"SUCCEEDED","statusMessage":"free user run limit exceeded",
 "stats":{"runTimeSecs":4.707},
 "storages":{"datasets":{"default":{"itemCount":0}}}}
```

An exhausted Apify quota returns SUCCEEDED with zero rows and says so in
`statusMessage`, a field nothing read. Reported as an empty search it becomes a
lie the whole way up: the tool tells the model "no profiles at this company",
the model concludes nobody is there, and a billing problem is recorded as a
fact about a business. `runActorViaMcp` now raises `ActorBlockedError` on it,
because no query will fix an account limit and the model must not be asked to
work around one.

Two sources are still right, but the independence claimed for them is thinner
than it looked. They were never independent of the account paying for both — a
plan cap takes out every actor at once. And once both were running in Full mode
against the same company they returned **the same three people in the same
order**, which is what one publisher over one backend looks like. So the
fallback covers an actor failing, not a data provider failing. A genuinely
independent second source would have to come from outside harvestapi.

**Both ways of finishing are tool calls.** `record_no_contact` exists because
"there is nobody to approach" is an answer, and an answer has to be committed
to be scoreable. While it was inferred from free text the runner labelled it
`no_block` — failure — even though the prompt told the model to do exactly
that. A tool call cannot be misread that way, and on a case whose correct
answer is "nobody" it is now the pass condition.

## What is constrained, and what is not

The rule: **constrain what is irreversible or unverifiable; inform everything
else.**

Constrained:

- **A fabricated observation reaching a person.** `record_contact` checks the
  cited quote against what the tools actually returned and refuses when absent.
  A committed result is grounded by construction rather than scored afterwards.
- **Money.** Each tool declares its cost and the budget refuses the call before
  it happens, in-band, so the model is told rather than killed.
- **Steps.** A ceiling, so a confused model stops.

Not constrained — the model decides, with the facts:

- which company a name refers to when several match
- whether the job poster is the hiring manager or a recruiter
- which titles to search, and how far to broaden
- **which source to use when one returns nothing.** An earlier version retried
  automatically. That was wrong: the right action is the same whether a source
  is empty or broken, so the decision never needed the diagnosis. The tool now
  says an empty result is ambiguous and names the other source.

## Layer 4 — evaluation

Built (Sprint 1 §2.1–§2.2). The harness is: goal, context, tools, limits,
record, evaluation. Without the sixth, a comparison can report that one model
took five calls and another ten, and nothing about whether either was right.

```
data/cases/cases.json        postings whose right answer is known
        │                    (outside git — real people, no consent)
        ▼
   runEvals(target, data)     Mastra drives the agent per case × provider
        │
        ├─▶ GATES   no_fabrication · grounded      must score 1
        └─▶ SCORED  answered · right_contact
                    trajectory (Mastra prebuilt)
                    right_person (judged, blind)
```

### The case set

`src/eval/cases.ts`. A case is a posting, its company (stored as **both** name
and LinkedIn URL, because a company can be renamed and then the URL points
nowhere), a shape, and every contact that would be a good answer.

Coverage is by **shape**, not count — ten easy postings measure nothing:

| shape | what it tests |
|---|---|
| `names_nobody` | find the company, then the person |
| `names_recruiter` | the poster is a recruiter; the answer is someone else |
| `ambiguous_company` | several companies share the name |
| `nobody_findable` | the correct answer is `record_no_contact` |

`validateCases()` refuses a set that cannot measure anything: fewer than two
`nobody_findable` cases and nothing ever tests for fabrication; fewer than two
holdout cases and tuning fits the labels and calls it progress.

`acceptable` is a **list**. At a sixty-person company a founder, a Head of
Product and the hiring manager are all defensible, and a single expected answer
marks two of them wrong.

The answers are Mahi's judgement, not ground truth — nobody has ground truth
until a reply arrives. That is a known limit, and real outcomes correct it
later (§2.4).

`prepare-cases.ts` generates the grading sheet and deliberately **pre-fills no
suggested answer**. If it did, grading would collapse into agreeing with the
machine, and the set would measure whether the agent agrees with Mahi rather
than whether it is right.

### The scorers

`src/eval/scorers/`. Four questions, one scorer each, because a single blended
number tells you a run got 0.6 and nothing about which half was wrong.

| scorer | asks | kind |
|---|---|---|
| `answered` | did it commit to anything at all | scored |
| `right_contact` | is the answer one Mahi accepts, including "nobody" | scored |
| `no_fabrication` | does the person named appear in tool output | **gate** |
| `grounded` | is the observation supported by cited text | **gate** |
| `trajectory` | did it use the tools sensibly | Mastra prebuilt |
| `right_person` | is this plausibly who decides | judged, blind |

Gates are gates because naming somebody who does not exist, or attaching an
invented sentence to somebody who does, is not a *worse* run — it is the one
outcome that reaches a stranger's inbox and cannot be taken back.

`right_contact` covers both directions on its own: a `nobody_findable` case has
an empty `acceptable` list, so committing nobody is the correct answer there.
`no_fabrication` is separate on purpose — naming a real employee who is not the
best contact is a judgement call, naming somebody who does not exist is a
fabrication, and collapsed into one scorer both read 0 and the difference
disappears.

**An unscoreable run is not a zero.** When evidence tools were called and
returned nothing, `grounded` throws instead of scoring. A blank transcript is a
broken harness, and scoring a harness fault as a model failure is the single
mistake that has cost this project the most time. `isUnscoreable(err)` matches
it through Mastra's error wrapping.

Reading a run back goes through Mastra's `extractToolResults`, not our own
message walking, so the harness reads a run the way the framework does. A
renamed field once turned a working model into a reported fabricator; that is
the class of bug this closes.

### Trajectory grading is Mastra's

`createTrajectoryScorerCode` from `@mastra/evals`, configured rather than
written: it grades expected steps, redundancy, step budget and tool-failure
patterns together. This is the scorer that catches the Layer 2 finding above
without a human reading a trace — eighteen consecutive searches, no result ever
read, no error, no answer, and nothing a single number would have shown.

`maxSteps: 12` is a **budget, not a ceiling**: exceeding it lowers the
efficiency sub-score rather than killing the run. A ceiling reported as failure
is what turned a run one step from finishing into "NO USABLE ANSWER".

### The judge is blind by construction

`rubricFor` takes an `EvalCase` and nothing else, so there is no path by which
the judge learns which model produced the answer. A comparison judged by one of
its own contestants flatters that contestant, and the point of the exercise is
comparing a small local model against a large hosted one.

The rubric grades the **role and the evidence**, never the name on Mahi's list.
A rubric that named his answer would be `right_contact` with a language model
bolted on, and would mark a better choice wrong for the same reason.

### Still to build

§2.3 the experiment runner (cases × providers, three runs per cell for
variance, `collectToolMocks` to replay recorded output so evals cost no Apify
spend and survive an outage) and §2.4 outcome capture, which is the only thing
that ever replaces Mahi's judgement with a real reply.


Seven harness faults on 2026-09-04 were each reported as a model failure and
none were:

| reported as | actually |
|---|---|
| NO USABLE ANSWER | step ceiling hit one step short |
| 16 tool calls | double-counted from two sources |
| not grounded (×3) | wrong field, JSON escaping, whole-field match |
| provider anthropic | label read config, not the CLI override |
| zero tool calls in 308s | 13k prompt into a 4k window, ×4 parallel slots |
| no company matched (×6) | multi-block MCP response glued into invalid JSON |
| stopped without answer | honest "found nobody", which the prompt asked for |

**The instrumentation has been wrong more often than the models.** That is what
Layer 4 is for, and why it precedes hardware decisions.

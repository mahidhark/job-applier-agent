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
LAYER 1  INFERENCE          Vercel AI SDK: anthropic | cerebras | ollama
              │             chosen per task, not globally
              ▼
LAYER 2  TOOLS              Mastra createTool over Apify MCP
              │             wrapped, never raw call-actor
              ▼
LAYER 3  AGENT              Mastra Agent — a goal, a step ceiling, a budget
              │
              ▼
LAYER 4  EVAL               Datasets · Scorers · Experiments · Traces
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
| `record_contact` | — commits the answer | $0 |

Two sources answer the same question deliberately. On 2026-09-04
`linkedin-profile-search` returned zero rows for every company including
Booking.com, having worked three hours earlier.

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

Not built. This is Sprint 1.

The harness is: goal, context, tools, limits, record, evaluation. The first
five exist. Without the sixth, a comparison can report that one model took five
calls and another ten, and nothing about whether either was right.

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

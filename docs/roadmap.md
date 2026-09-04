# Roadmap — job-applier-agent

*Draft. Not ratified.*

Phases are ordered by what unblocks the next thing, not by size. The recurring
mistake this ordering avoids: building capability before building the ability
to tell whether the capability works.

## Where it stands (2026-09-04)

Working end to end on live data:

- Three official job-board APIs (Ashby, Greenhouse, Lever), verified live
- Paid LinkedIn discovery via Apify, behind the gates
- Deterministic screening and scoring — 3,088 postings in, 38 kept
- SQLite state, and `explain` for why any posting was skipped
- A goal-directed Mastra agent over Apify MCP, provider-switchable
- Grounding verification, extracted and tested after failing three ways

Measured, not assumed:

- Claude on the enrich goal: 8–14 tool calls, 130–156s, ~$0.13 of Apify
- qwen2.5:3b: **failed at the context limit, not the task.** 40,750 characters
  of tool schema puts the first request at ~13,090 tokens against a 4,096-token
  default. 3.2× over. It never saw the goal.

Never measured, because nothing records it:

- Whether any contact this system found was the right one
- Whether any message was accepted, replied to, or led anywhere

## Phase 1 — Make the experiment answerable

The SLM question is currently unanswered for a reason that has nothing to do
with the model. Raise `num_ctx`, cut the tool surface to what the goal needs,
re-run. If it still fails, that is a finding; today's result is not.

Also: **start recording outcomes.** This is worthless retroactively and cheap
now. Every day without it is a day of evidence that cannot be recovered.

## Phase 2 — An eval set, and scorers that do not need a model

Fifteen hand-labelled postings where the right contact is known. Deterministic
scorers first because they cost nothing and catch most regressions: right
company, well-formed profile, grounded observation, tool calls, spend, latency,
hallucinated tool names.

A judge only for what genuinely needs judgment — "is this plausibly the person
who decides" — and blind to which model produced the answer, or the comparison
flatters whichever model is also judging.

## Phase 3 — Observability

Traces already exist per run. What is missing is aggregation and alarms: cost
per usable contact, grounding rate over time, provider comparison, and the one
that will actually bite — **a source going dark.** A board returning zero for
three consecutive polls means its slug rotted, and today that is silent.

## Phase 4 — Close the enrichment gap for the majority

The people search needs a LinkedIn company URL. Board-sourced postings carry
none, and boards are most of the pipeline. The agent can resolve it, but each
resolution is a paid call and a chance to pick the wrong company; resolved URLs
should be cached per company, not re-derived per posting.

## Phase 5 — Drafting

The connection note: 300 characters, grounded in the evidence corpus, carrying
the observation. This is deliberately late. A perfect note to the wrong person
is worth nothing, and until Phase 2 there is no way to know whether the person
is right.

## Phase 6 — Separate the operator from the system

Everything personal is currently hardcoded: corpus path, country, home cities,
target titles. Extracting it into one profile makes the boundary explicit and
keeps a multi-user question answerable later without committing to it now.

## Deliberately not on this roadmap

- **Sending anything.** See vision.md.
- **Self-improving agents.** The SIA pattern needs an objective score per
  generation. This system's real outcome is sparse, delayed and confounded; an
  agent rewriting its own prompt against ten noisy samples a week would be
  fitting noise while spending money and messaging real people.
- **Semantic retrieval.** `nomic-embed-text` is already on the box and would
  replace lexical tag matching. Tempting and unjustified — the current
  retrieval has not yet failed in a way embeddings would fix.
- **Multi-tenancy.** One user. Building for imagined others is how the real one
  gets served badly.

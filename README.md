# job-applier-agent

Finds full-time roles worth applying to, works out who to talk to, and drafts
the outreach. **Sending stays human, by design.**

```
discover  →  screen  →  score  →  enrich  →  queue  →  [you send]
 free +       hard      rank     paid,      review
 one paid     gates              gated
```

## Why the send is not automated

The evidence for this is measured, not principled. Across ~50 form
applications the operator got 1–2 callbacks (~3%). Across cold LinkedIn
messages that were accepted, 10 accepts produced 4–5 recruiter calls (~50%).
Outreach converts 15–20× better, so the outreach is the application and the
form is a compliance step.

Automating the *send* saves about fifteen seconds per contact and moves that
50% not at all — acceptance is decided by who you picked and what the note
says, both of which happen before the click. It is the one step in the funnel
with no leverage and all of the risk: automated connection requests violate
LinkedIn's User Agreement, are detected by request velocity, and cost you the
account carrying your professional history.

So this repo automates everything upstream of the click and stops. The last
state it can write is `queued`.

## Quick start

```bash
npm install
npm run sources          # check every configured board answers
npm run poll:once        # one discovery + screening pass
npm run status           # what was kept, and why the rest was not
npm run queue            # the list to work through by hand
npm run explain -- <id>  # why one posting was skipped, or never seen
```

Then, for one posting, work out who to talk to:

```bash
npm run connections      # which MCP servers are reachable, no spend
npm run agent -- <id>              # find the contact for one posting
npm run agent -- --compare <id>    # anthropic and cerebras, same inputs
npm run agent -- --providers anthropic,ollama --tools narrow <id>
```

And to measure whether that is any good:

```bash
npm run cases:prepare -- --n 10   # build a grading sheet
npm run cases:check               # refuse a set that cannot measure anything
npm test
npm run typecheck
```

No API key is needed for the free boards. `APIFY_TOKEN` unlocks paid LinkedIn
discovery *and* the enrichment agent; without it, discovery skips that source
with a warning and the agent refuses to start. `ANTHROPIC_API_KEY` or
`CEREBRAS_API_KEY` pick the model — Ollama needs neither.

## Sources

**Free, official, no scraping.** Most companies worth working for run a
public job-board API. Adding one is a line in `config/sources/ats.json`:

| ATS | Endpoint | Verified |
|---|---|---|
| Ashby | `api.ashbyhq.com/posting-api/job-board/<slug>` | 2026-09-04 |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true` | 2026-09-04 |
| Lever | `api.lever.co/v0/postings/<slug>?mode=json` | 2026-09-04 |

Find the slug in the careers-page source — Greenhouse embeds
`greenhouse.io/embed/job_board/js?for=<slug>`.

**Paid, for companies not on a known board.** Apify's LinkedIn job actors, in
`config/sources/searches.json`. This is the only thing that costs money, so it
is deliberately thin: enough to run the gates, nothing more. Everything
expensive happens after the gates, on survivors.

## Configuration

Split by concern, because the source lists grow without bound while the rubric
does not — adding a company should not be a diff against your scoring weights.

```
config/
├── default.json           thresholds, scoring weights, drafting, queue caps
└── sources/
    ├── ats.json           free official boards: company, ats, slug
    └── searches.json      paid Apify searches
```

`loadConfig()` validates and throws rather than running with a missing section,
because a silently-absent threshold is a gate that never fires.

## Things that are load-bearing and easy to miss

**Deduplication runs *after* screening, not before.** One company in the test
set lists the same role in every market it operates in — 3,084 postings, the
same "Technical Product Lead" eight times over. Deduplicating first and keeping
whichever came back first threw away the Netherlands variant and judged its
Sydney twin, rejecting 287 of 291 postings on location. Screening every variant
costs nothing (the gates are pure functions), so every variant is judged and
the survivor of a duplicate set is a role you can actually take.

**Freshness is a scoring signal, not really a gate.** On a freelance
marketplace, age decides your queue position. A permanent role open for three
months just means they have not found anyone, which is information in your
favour. Two live roles at 59 and 86 days were still open and worth applying to;
a 30-day gate rejected both. The gate now sits at 120 days and exists only to
drop postings a board forgot to close.

**`applicantCount` from LinkedIn is bucketed, not measured.** A live run
returned 25, 179, 25, 25, 112. A 25 means "25 or unknown". Usable as a weak
ranking signal, never as a gate.

**`jobPoster` is a lead, not an answer.** It populates on roughly 40% of
LinkedIn postings, and when present is as often a recruiter as the hiring
manager. Check the title before believing it.

**A location a board states but we cannot recognise is a rejection.** An
earlier version treated a short bare locality as "country unknown" and passed
it; that let thousands of postings across every Asian market through. Boards
write "Utrecht" without the country, so home localities are matched by name in
`screen.homeLocalities` and everything unrecognised is rejected.

## Who to talk to — the enrichment agent

`src/agent/`. A Mastra agent given a goal, five tools and a budget, which
decides for itself which company a name refers to, whether the job poster is a
recruiter or the hiring manager, and how far to broaden a search.

**The tool surface is the load-bearing decision, and it is measured.** Given
Apify's raw MCP surface — *call actor → get datasetId → call get-dataset-items*
— `gpt-oss-120b` spent all twenty of its steps making eighteen consecutive
profile searches and never once read a result. The same model on five wrapped
tools finished in five calls:

| surface | tool calls | wall time | behaviour |
|---|---|---|---|
| raw Apify MCP | 20 (ceiling) | 224.6s | never read a result |
| wrapped tools | 5 | 59.5s | resolve, search, refine, refine |

A 120B model failed on the raw surface, so a 4B has no chance. Fixing the
surface precedes local-model work rather than following it.

The rule the agent is built on: **constrain what is irreversible or
unverifiable; inform everything else.** Money and fabrication are constrained —
each tool declares its price and the budget refuses the call in-band, and
`record_contact` checks the cited quote against what the tools actually
returned and refuses when it is absent. Everything else is the model's call,
including which source to use when one returns nothing: an earlier version
retried automatically, which was wrong, because the right action is the same
whether a source is empty or broken and so the decision never needed the
diagnosis.

Model choice is per task, through the Vercel AI SDK: `anthropic`, `cerebras`
or `ollama`. Same goal, same tools, same orchestrator, one variable changed.

## Does it work? — the eval harness

`src/eval/`. Without this, a comparison can report that one model took five
tool calls and another ten, and nothing about whether either found the right
person.

A **case** is a posting whose right answer is already known, with *every*
contact that would be a good answer — at a sixty-person company a founder and a
Head of Product are both defensible, and a single expected answer marks one of
them wrong. Coverage is by shape rather than count, because ten easy postings
measure nothing, and at least two cases must be ones where the correct answer
is that **nobody** is reachable.

Six scorers, each asking one question:

| scorer | asks | kind |
|---|---|---|
| `answered` | did it commit to anything at all | scored |
| `right_contact` | is the answer one you accept, including "nobody" | scored |
| `no_fabrication` | does the person named appear in tool output | **gate** |
| `grounded` | is the observation supported by cited text | **gate** |
| `trajectory` | did it use the tools sensibly | Mastra prebuilt |
| `right_person` | is this plausibly who decides | judged, blind |

Two of them are gates rather than scores, because naming somebody who does not
exist — or attaching an invented sentence to somebody who does — is not a
*worse* run. It is the one outcome that reaches a stranger's inbox and cannot
be taken back.

**An unscoreable run is not a zero.** When evidence tools were called and came
back with nothing, the grounding scorer throws instead of scoring. A blank
transcript is a broken harness, and on this project the instrumentation has
been wrong more often than the models have: seven "model failures" in one
afternoon were all harness faults, including a step ceiling hit one step short
of the answer, and an honest "found nobody" that the prompt had asked for.

Details in [docs/architecture.md](docs/architecture.md); the schema is in
[docs/database.md](docs/database.md).

## Status

Working end to end on live data: the three board adapters, the Apify discovery
source, gates, scoring, the SQLite store, the enrichment agent, and the
`poll` / `sources` / `status` / `queue` / `explain` / `agent` commands.

The eval harness has its case schema and its scorers. Still to come: the
experiment runner (cases × providers, three runs per cell for variance) and
outcome capture — the only thing that ever replaces judgement with a real
reply.

Not yet built: `src/draft/`, the 300-character connection note grounded in an
evidence corpus. Until it exists `npm run queue` shows the contact and the
grounded observation, and you write the note yourself.

## Constraints

- **No personal data in this repo.** The evidence corpus, CVs, the database and
  the queue all live outside it. `data/`, `corpus/` and `cv*/` are gitignored.
- Node 22+.
- Nothing here sends a message, a connection request, or an application.

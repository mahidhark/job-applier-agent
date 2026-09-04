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

No API key is needed for the free boards. `APIFY_TOKEN` unlocks paid LinkedIn
discovery; without it that source is skipped with a warning.

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

## Status

Built and working end to end on live data: the three board adapters, the
Apify discovery source, gates, scoring, the SQLite store, and the
`poll` / `sources` / `status` / `queue` / `explain` commands.

Not yet built: `src/enrich/` (resolving a hiring manager when the job poster
is absent, and pulling recent posts for a specific observation) and
`src/draft/` (the 300-character connection note, grounded in an evidence
corpus). Their interfaces are defined; the work is the next session.

## Constraints

- **No personal data in this repo.** The evidence corpus, CVs, the database and
  the queue all live outside it. `data/`, `corpus/` and `cv*/` are gitignored.
- Node 22+.
- Nothing here sends a message, a connection request, or an application.

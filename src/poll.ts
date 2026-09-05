/**
 * The whole pipeline, on a timer.
 *
 *   discover (cheap) -> screen -> score -> [enrich] -> queue
 *
 * Reading this file top to bottom explains the system. Everything else is a
 * library it calls. There is no queue, no server, no IPC.
 *
 * The ordering is the cost model: free board APIs and one thin paid search
 * produce candidates, the gates throw most of them away for nothing, and only
 * survivors reach the enrichment that bills per profile.
 *
 * Nothing in this process contacts a person. The last state it can write is
 * `queued`.
 */
import { loadConfig } from './config-file.js';
import { buildSources } from './sources/index.js';
import { screen, passed, failures } from './screen/gates.js';
import { scoreJob } from './score/score.js';
import {
  upsertJob, setState, setScore, recordGate, spentLast24h, upsertRole, setRoleId, taxonomyFor,
} from './store/db.js';
import { roleKey, roleCore, qualifierOf } from './roles/key.js';
import { taxonomyFromStore, unitFor } from './roles/taxonomy.js';

const once = process.argv.includes('--once');

async function pass(): Promise<void> {
  const config = loadConfig();
  const now = new Date();
  const sources = buildSources(config);

  console.log(`\n  ${now.toISOString()}  ${sources.length} sources`);
  // TWO BUDGETS, because these are not the same kind of spending.
  //
  // Discovery is $0.0004 a result — a full pass over every configured search is
  // about seven cents. A single contact lookup is $0.14, twice that. Under one
  // shared cap, two lookups permanently starve the thing that feeds the funnel,
  // which is exactly what happened on 2026-09-04: a seven-cent discovery pass
  // blocked by $2.04 of unrelated enrichment.
  const discoverBudget = config.searches.maxSpendPerDayUsd;
  const spentDiscovering = spentLast24h('discover');
  if (spentDiscovering >= discoverBudget) {
    console.log(
      `  ! $${spentDiscovering.toFixed(2)} spent discovering in 24h, ` +
      `budget $${discoverBudget} — paid sources skipped`,
    );
  }
  const spentEnriching = spentLast24h('enrich');
  if (spentEnriching >= config.enrich.maxSpendPerDayUsd) {
    console.log(
      `  ! $${spentEnriching.toFixed(2)} spent enriching in 24h, ` +
      `budget $${config.enrich.maxSpendPerDayUsd} — contact lookups will refuse`,
    );
  }

  let seen = 0, fresh = 0, accepted = 0, variants = 0;
  const survivors: Awaited<ReturnType<(typeof sources)[number]['fetch']>> = [];
  const shortlist: Array<{
    id: string; title: string; company: string; score: number; variants: number;
  }> = [];

  for (const source of sources) {
    if (source.paid && spentDiscovering >= discoverBudget) continue;

    let jobs;
    try {
      jobs = await source.fetch();
    } catch (err) {
      // One bad board must not stop the pass. A slug changes, a board 404s,
      // and the other nine still have work to do.
      console.error(`  ! ${source.name}: ${(err as Error).message}`);
      continue;
    }

    for (const job of jobs) {
      seen++;
      const isNew = upsertJob(job, 'seen');
      if (!isNew) continue; // already judged on an earlier pass
      fresh++;

      const outcomes = screen(job, now, config.screen);
      for (const o of outcomes) recordGate(job.id, o.gate, o.passed, o.detail);

      if (!passed(outcomes)) {
        setState(job.id, 'rejected');
        continue;
      }
      survivors.push(job);
    }
  }

  // GROUP AFTER SCREENING, not before.
  //
  // Bjak lists one posting per market — the same "Technical Product Lead"
  // across every country it operates in. Grouping first and keeping whichever
  // came back first threw away the Netherlands variant and judged its Sydney
  // twin, which rejected 287 of 291 postings on location. Screening every
  // posting costs nothing (the gates are pure) and leaves only the ones that
  // actually qualify, so the representative of a group is a role we can
  // genuinely take.
  //
  // This replaces a dedupe that keyed on company plus EXACT title and caught
  // almost nothing: Bjak's eight spellings of one job differ only by a trailing
  // product name, so they were eight roles, eight queue entries, and would have
  // been eight paid contact lookups for the same person.
  //
  // Score everything first. Scoring is pure and does no I/O, so it is free, and
  // the representative is chosen partly on score — which cannot be done if only
  // the winner is scored. Variants keep their scores, so a group can be read
  // later without recomputing anything.
  const scores = new Map<string, number>();
  for (const job of survivors) {
    const total = scoreJob(job, now, config.score, config.screen).total;
    scores.set(job.id, total);
    setScore(job.id, total);
  }

  // The unit comes from what the store already knows about the company.
  //
  // READ ONLY — no model call on the poll path. A company with no recorded
  // taxonomy gets a single unit, which reproduces the pre-taxonomy grouping
  // exactly, so an unattended poll can never be blocked or billed by this.
  // Deriving a taxonomy for a new company is a deliberate act.
  const taxonomies = new Map<string, ReturnType<typeof taxonomyFromStore>>();
  const taxonomyOf = (company: string) => {
    const key = company.toLowerCase();
    let t = taxonomies.get(key);
    if (!t) { t = taxonomyFromStore(taxonomyFor(key)); taxonomies.set(key, t); }
    return t;
  };

  const groups = new Map<string, typeof survivors>();
  for (const job of survivors) {
    const unit = unitFor(taxonomyOf(job.company), qualifierOf(job.title));
    const key = roleKey(job.company, unit, job.title);
    const bucket = groups.get(key);
    if (bucket) bucket.push(job);
    else groups.set(key, [job]);
  }

  for (const [key, members] of groups) {
    const unit = unitFor(taxonomyOf(members[0]!.company), qualifierOf(members[0]!.title));
    upsertRole(key, members[0]!.company, key, roleCore(members[0]!.title), unit);

    // Which posting represents the group.
    //
    // NOT location, though the plan first said so: every survivor has already
    // passed `location_eligible`, because `passed()` is an AND across all
    // gates. A location tiebreak here could never discriminate. So freshest,
    // then best scored, then lowest id — the last purely so the choice is
    // stable between runs and the queue does not reshuffle for no reason.
    const ranked = [...members].sort((a, b) => {
      const at = a.postedAt ? Date.parse(a.postedAt) : 0;
      const bt = b.postedAt ? Date.parse(b.postedAt) : 0;
      if (at !== bt) return bt - at;
      const as = scores.get(a.id) ?? 0;
      const bs = scores.get(b.id) ?? 0;
      if (as !== bs) return bs - as;
      return a.id < b.id ? -1 : 1;
    });

    for (const [i, job] of ranked.entries()) {
      setRoleId(job.id, key);
      if (i === 0) {
        setState(job.id, 'scored');
        accepted++;
        shortlist.push({
          id: job.id, title: job.title, company: job.company,
          score: scores.get(job.id) ?? 0, variants: ranked.length - 1,
        });
      } else {
        setState(job.id, 'variant');
        variants++;
      }
    }
  }

  shortlist.sort((a, b) => b.score - a.score);
  console.log(
    `  ${seen} seen, ${fresh} new, ${accepted} role(s) kept ` +
    `(${variants} further listing(s) of those same roles)`,
  );
  for (const s of shortlist.slice(0, config.queue.maxPerDay)) {
    console.log(
      `    ${s.score.toFixed(1).padStart(5)}  ${s.company} — ${s.title.slice(0, 60)}` +
      (s.variants ? `  (+${s.variants} more listing${s.variants === 1 ? '' : 's'})` : ''),
    );
  }
  if (accepted > 0) console.log(`\n  next: npm run queue\n`);
}

async function main(): Promise<void> {
  const { pollIntervalMinutes } = loadConfig();
  await pass();
  if (once) return;

  console.log(`  polling every ${pollIntervalMinutes} minutes — ctrl-c to stop`);
  setInterval(() => {
    pass().catch((err) => console.error(`  ! pass failed: ${(err as Error).message}`));
  }, pollIntervalMinutes * 60_000);
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

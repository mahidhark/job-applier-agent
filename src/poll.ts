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
import { upsertJob, setState, setScore, recordGate, spentLast24h, upsertRole, setRoleId } from './store/db.js';
import { roleKey, roleCore } from './roles/key.js';

const once = process.argv.includes('--once');

async function pass(): Promise<void> {
  const config = loadConfig();
  const now = new Date();
  const sources = buildSources(config);

  console.log(`\n  ${now.toISOString()}  ${sources.length} sources`);
  const budget = config.enrich.maxSpendPerDayUsd;
  const spent = spentLast24h();
  if (spent >= budget) {
    console.log(`  ! $${spent.toFixed(2)} spent in 24h, budget $${budget} — paid sources skipped`);
  }

  let seen = 0, fresh = 0, accepted = 0, variants = 0;
  const survivors: Awaited<ReturnType<(typeof sources)[number]['fetch']>> = [];
  const shortlist: Array<{
    id: string; title: string; company: string; score: number; variants: number;
  }> = [];

  for (const source of sources) {
    if (source.paid && spent >= budget) continue;

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

  const groups = new Map<string, typeof survivors>();
  for (const job of survivors) {
    const key = roleKey(job.company, job.title);
    const bucket = groups.get(key);
    if (bucket) bucket.push(job);
    else groups.set(key, [job]);
  }

  for (const [key, members] of groups) {
    upsertRole(key, members[0]!.company, key, roleCore(members[0]!.title));

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

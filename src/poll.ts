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
import { upsertJob, setState, setScore, recordGate, spentLast24h } from './store/db.js';

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

  let seen = 0, fresh = 0, accepted = 0, duplicates = 0;
  const survivors: Awaited<ReturnType<(typeof sources)[number]['fetch']>> = [];
  const shortlist: Array<{ id: string; title: string; company: string; score: number }> = [];

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

  // Dedupe AFTER screening, not before.
  //
  // Bjak lists one posting per market — the same "Technical Product Lead"
  // across every country it operates in. Deduping first and keeping whichever
  // came back first threw away the Netherlands variant and judged its Sydney
  // twin, which rejected 287 of 291 postings on location. Screening every
  // variant costs nothing (the gates are pure) and leaves only the ones that
  // actually qualify, so the survivor of a duplicate set is a role we can
  // genuinely take.
  const kept = new Map<string, (typeof survivors)[number]>();
  for (const job of survivors) {
    const key = `${job.company.toLowerCase().trim()}::${job.title.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (kept.has(key)) { duplicates++; setState(job.id, 'skipped'); continue; }
    kept.set(key, job);
  }

  for (const job of kept.values()) {
    const breakdown = scoreJob(job, now, config.score, config.screen);
    setScore(job.id, breakdown.total);
    setState(job.id, 'scored');
    accepted++;
    shortlist.push({ id: job.id, title: job.title, company: job.company, score: breakdown.total });
  }

  shortlist.sort((a, b) => b.score - a.score);
  console.log(
    `  ${seen} seen, ${fresh} new, ${accepted} kept ` +
    `(${duplicates} duplicate listings of a kept role dropped)`,
  );
  for (const s of shortlist.slice(0, config.queue.maxPerDay)) {
    console.log(`    ${s.score.toFixed(1).padStart(5)}  ${s.company} — ${s.title.slice(0, 60)}`);
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

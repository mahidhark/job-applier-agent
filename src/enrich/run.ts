/**
 * Enrich the top scored postings, or one by id.
 *
 *   npm run enrich              the top N by score
 *   npm run enrich -- <job-id>  just that one
 *   npm run enrich -- --dry     show the plan and spend ceiling, call nothing
 */
import { loadConfig } from '../config-file.js';
import { q, spentLast24h } from '../store/db.js';
import { closeMcp } from './mcp.js';
import { enrichJob } from './enrich.js';
import type { JobPosting } from '../sources/types.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const only = args.find((a) => !a.startsWith('--'));

async function main() {
  const config = loadConfig();
  const rows = only
    ? q<{ id: string; raw: string }>('SELECT id, raw FROM jobs WHERE id = ?', only)
    : q<{ id: string; raw: string }>(
        `SELECT id, raw FROM jobs WHERE state = 'scored' ORDER BY score DESC LIMIT ?`,
        config.queue.maxPerDay,
      );

  if (!rows.length) {
    console.log('\n  Nothing to enrich. Run `npm run poll:once` first.\n');
    return;
  }

  const budget = config.enrich.maxSpendPerDayUsd - spentLast24h();
  console.log(`\n  ${rows.length} to enrich · provider ${config.ai.tasks?.tools ?? config.ai.provider}` +
              ` · $${budget.toFixed(2)} of today's budget left\n`);

  if (dry) {
    for (const r of rows) {
      const job = JSON.parse(r.raw) as JobPosting;
      console.log(`  ${job.company} — ${job.title}`);
      console.log(`    poster: ${job.contactName ?? 'none named'}${job.contactTitle ? ` (${job.contactTitle})` : ''}`);
      console.log(`    company LinkedIn: ${job.companyLinkedinUrl ?? 'unknown'}\n`);
    }
    console.log('  --dry: nothing called, nothing spent.\n');
    return;
  }

  for (const r of rows) {
    const job = JSON.parse(r.raw) as JobPosting;
    console.log(`${'─'.repeat(72)}\n  ${job.company} — ${job.title}`);

    const { result, run } = await enrichJob(job, config);

    for (const t of run.trace) {
      const calls = t.calls.map((c) => `${c.ok ? '' : '✗ '}${c.name}`).join(', ') || '(no tools)';
      console.log(`    step ${t.step}  ${String(t.latencyMs).padStart(6)}ms  ${calls}`);
    }
    console.log(`    ${run.stopReason} after ${run.steps} steps, $${run.spentUsd.toFixed(3)}`);

    if (result) {
      console.log(`\n    → ${result.name}${result.title ? ` — ${result.title}` : ''}`);
      console.log(`      ${result.profileUrl}`);
      if (result.observation) console.log(`      observation: ${result.observation}`);
      console.log(`      why: ${result.reasoning}\n`);
    } else {
      console.log(`\n    no contact found: ${run.error ?? run.answer.slice(0, 200)}\n`);
    }
  }
  await closeMcp();
}

main().catch(async (err) => {
  await closeMcp();
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

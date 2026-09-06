/**
 * Two one-shot repairs of live data, from the outcome-capture plan §3.
 *
 *   npm run repair                          DRY RUN — shows what it would do
 *   npm run repair -- --apply --backup <p>  does it
 *   npm run repair -- --apply --force       does it without a backup
 *
 * DRY RUN IS THE DEFAULT and `--apply` needs a backup path or an explicit
 * `--force`, because this is the only code in the repo that writes to rows a
 * human already acted on. Everything else either inserts what a source
 * returned or updates state the machine itself set.
 *
 * Both repairs are idempotent: re-running finds nothing to do. Neither is a
 * migration in the schema sense — no column changes, no runner, no version.
 * When these two have run, this file has no reason to exist and should be
 * deleted rather than kept as a general-purpose fixer.
 */
import { q, run } from './db.js';
import { scoreJob } from '../score/score.js';
import { loadConfig } from '../config-file.js';
import type { JobPosting } from '../sources/types.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const force = args.includes('--force');
const backup = args[args.indexOf('--backup') + 1];
const hasBackup = args.includes('--backup') && Boolean(backup) && !backup!.startsWith('--');

if (apply && !hasBackup && !force) {
  console.error(
    '\n  Refusing to write.\n\n' +
    '  These repairs rewrite rows a human acted on, and one of them deletes\n' +
    '  contact rows permanently. Give a backup path or say --force:\n\n' +
    '    cp ~/.job-applier-agent/agent.db ~/agent.db.bak\n' +
    '    npm run repair -- --apply --backup ~/agent.db.bak\n',
  );
  process.exit(1);
}

const mode = apply ? 'APPLYING' : 'DRY RUN — nothing will be written';
console.log(`\n  ${mode}\n${'─'.repeat(74)}`);

/* ────────────────────────────────────────────────────────────────────────────
 * §3.1 — the stranded `skipped` rows
 *
 * Every `skipped` row in the store is a pre-`variant` machine dedupe from the
 * exact-title dedupe that grouping replaced: Bjak, Ashby, score NULL, role_id
 * NULL, and each passed every gate. None of them are Mahi's rejections, so
 * `status` reporting "12 skipped" tells him he rejected twelve roles he never
 * saw.
 *
 * SCORED BEFORE THE STATE CHANGES, and that ordering is the whole trick.
 * `roles.ts` backfill ranks representatives by posted_at BEFORE score, so
 * restoring an unscored row could hand it a representative slot ahead of a
 * properly scored sibling. Scoring is pure and free, and every row's
 * JobPosting is already sitting in `jobs.raw`.
 * ──────────────────────────────────────────────────────────────────────────── */
function restoreStranded(): number {
  const rows = q<{ id: string; title: string; company: string; score: number | null; raw: string }>(
    `SELECT id, title, company, score, raw FROM jobs WHERE state = 'skipped' ORDER BY title`,
  );
  console.log(`\n  §3.1  ${rows.length} row(s) in 'skipped'`);
  if (!rows.length) {
    console.log('        nothing to do.');
    return 0;
  }

  const config = loadConfig();
  const now = new Date();
  for (const r of rows) {
    const job = JSON.parse(r.raw) as JobPosting;
    const score = scoreJob(job, now, config.score, config.screen).total;
    console.log(
      `        ${(r.score ?? 0).toFixed(1).padStart(5)} -> ${score.toFixed(1).padStart(5)}  ` +
      `${r.company} — ${r.title.slice(0, 46)}`,
    );
    if (apply) {
      run('UPDATE jobs SET score = ?, state = ? WHERE id = ?', score, 'variant', r.id);
    }
  }
  console.log(`\n        ids, for rollback: ${rows.map((r) => r.id).join(' ')}`);
  return rows.length;
}

/* ────────────────────────────────────────────────────────────────────────────
 * §3.2 — contacts that cannot be joined to or opened
 *
 * Two rules rather than two hardcoded ids, so this stays honest if it is ever
 * re-run:
 *
 *   DANGLING   no `jobs` row for the job_id. Residue of the ESM-hoisting
 *              incident, which wrote 99 test rows into the live database
 *              because `process.env.JOB_AGENT_DB = ...` ran after the import
 *              that opened it.
 *
 *   DEAD LINK  profile_url is an opaque `/in/ACw...` member id rather than a
 *              profile. That is the Short-mode bug in live data: we paid for a
 *              source and stored a link nobody can open.
 *
 * It matters now rather than later because `outcomes.contact_url` joins to
 * these rows, and a dead URL as an outcome key is a corrupted scoreboard on
 * day one.
 *
 * THE ROWS ARE PRINTED BEFORE THEY GO. They name real people, so they cannot
 * be copied into the repo as a backup — the print is the record, and it is
 * Mahi's to keep or discard. Deletion here is final.
 * ──────────────────────────────────────────────────────────────────────────── */
function cleanContacts(): number {
  const doomed = q<{ job_id: string; name: string; title: string | null; profile_url: string | null }>(
    `SELECT job_id, name, title, profile_url FROM contacts
      WHERE job_id NOT IN (SELECT id FROM jobs)
         OR profile_url LIKE '%/in/ACw%'
      ORDER BY job_id`,
  );
  console.log(`\n  §3.2  ${doomed.length} contact row(s) to remove`);
  if (!doomed.length) {
    console.log('        nothing to do.');
    return 0;
  }

  for (const c of doomed) {
    const why = c.job_id.startsWith('test:') || !c.profile_url?.includes('/in/ACw')
      ? 'no jobs row' : 'opaque member id';
    console.log(
      `        ${c.job_id.padEnd(24)} ${c.name.padEnd(20)} ` +
      `${(c.title ?? '(no title)').slice(0, 24).padEnd(24)} ${c.profile_url ?? ''}`,
    );
    console.log(`        ${' '.repeat(24)} reason: ${why}`);
  }
  console.log('\n        ^ keep this output. These rows name real people and');
  console.log('          cannot be backed up into the repo. Deletion is final.');

  if (apply) {
    run(`DELETE FROM contacts
          WHERE job_id NOT IN (SELECT id FROM jobs)
             OR profile_url LIKE '%/in/ACw%'`);
  }
  return doomed.length;
}

const restored = restoreStranded();
const removed = cleanContacts();

console.log(`\n${'─'.repeat(74)}`);
if (apply) {
  console.log(`  Done. ${restored} restored to variant, ${removed} contact row(s) removed.`);
  if (restored) {
    // Grouping stays in one place. This assigns the role_id these rows have
    // never had, and picks representatives with the scores just written.
    console.log('\n  NOW RUN:  npm run roles -- --backfill');
  }
  console.log('');
} else {
  console.log('  Nothing written. Re-run with --apply --backup <path> to do it.\n');
}

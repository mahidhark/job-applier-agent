/**
 * The day's outreach queue, and the only place a human closes the loop.
 *
 *   npm run queue                 show today's queue
 *   npm run queue -- --sent <id>  mark one as contacted, by hand
 *   npm run queue -- --skip <id>  drop one without contacting
 *
 * The agent stops at `queued` on purpose. Sending a connection request or a
 * message from automation is against LinkedIn's terms and puts the account
 * that carries your professional history at risk — and it is the one step in
 * the funnel with no leverage in it, since acceptance is decided by who you
 * picked and what the note says, both of which happen before the click.
 */
import {
  q, setState, postingsInRole, recordOutcome, jobExists, outcomesFor,
  type OutcomeEvent,
} from './store/db.js';
import { qualifierOf } from './roles/key.js';
import { loadConfig } from './config-file.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * Which person an outcome is about.
 *
 * One contact on the posting is the overwhelmingly common case, so it is used
 * without asking. More than one is genuinely ambiguous and guessing would
 * attach a reply to the wrong human, so it asks. None means the outreach was
 * to somebody found by hand, which is a real case and records as ''.
 */
function contactUrlFor(jobId: string, override?: string): string | null {
  if (override) return override;
  const rows = q<{ profile_url: string | null }>(
    'SELECT profile_url FROM contacts WHERE job_id = ? AND profile_url IS NOT NULL', jobId,
  );
  if (rows.length === 1) return rows[0]!.profile_url;
  if (rows.length === 0) return '';
  console.error(
    `\n  ${jobId} has ${rows.length} contacts. Say which:\n` +
    rows.map((r) => `    --contact ${r.profile_url}`).join('\n') + '\n',
  );
  return null;
}

const skip = flag('--skip');
if (skip) {
  // A STATE, not an outcome: this is Mahi deciding before any contact happens.
  // Its opposite number after contact is `--declined`, deliberately not
  // `--rejected` — two words that look alike either side of the funnel get
  // confused permanently.
  if (!jobExists(skip)) {
    console.error(`\n  no posting with id ${skip}.\n`);
    process.exit(1);
  }
  setState(skip, 'skipped');
  console.log(`\n  ${skip} skipped.\n`);
  process.exit(0);
}

const EVENTS: OutcomeEvent[] = ['sent', 'accepted', 'replied', 'declined'];
for (const event of EVENTS) {
  const id = flag(`--${event}`);
  if (!id) continue;

  // Refuse an unknown id rather than inserting an orphan. A mistyped job id
  // would otherwise record an outcome nothing can ever join back to.
  if (!jobExists(id)) {
    console.error(`\n  no posting with id ${id}. Nothing recorded.\n`);
    process.exit(1);
  }

  const url = contactUrlFor(id, flag('--contact'));
  if (url === null) process.exit(1);

  const note = flag('--note') ?? null;
  recordOutcome(id, url, event, { note });

  console.log(`\n  ${id} — ${event}${url ? ` (${url})` : ' (no contact recorded)'}`);
  if (event === 'declined' && !note) {
    // Prompt, do not refuse. A refusal loses the fact to protect the
    // annotation, and the fact is the part that cannot be recovered later.
    console.log(`  why? re-run with  --note "..."  — a declined with no reason teaches nothing.`);
  }
  console.log('');
  process.exit(0);
}

const config = loadConfig();
// One entry per ROLE, not per posting. Variants sit in the `variant` state and
// are listed underneath rather than competing for a slot — Bjak alone would
// otherwise fill the whole day's queue with one job advertised eight ways.
//
// A posting leaves this list by acquiring an OUTCOME, not by changing state.
// `enriched` and `queued` used to be in this filter and were never written by
// anything, so the query worked only because of `scored`.
const rows = q<{
  id: string; company: string; title: string; score: number; url: string; state: string;
  role_id: string | null;
}>(
  `SELECT id, company, title, score, url, state, role_id FROM jobs
   WHERE state = 'scored' AND id NOT IN (SELECT job_id FROM outcomes)
   ORDER BY score DESC LIMIT ?`,
  config.queue.maxPerDay,
);

if (!rows.length) {
  console.log('\n  Queue is empty. Run `npm run poll:once` to look for work.\n');
  process.exit(0);
}

console.log(`\n  ${rows.length} to work through — send these yourself.\n`);

for (const r of rows) {
  console.log(`${'─'.repeat(72)}`);
  console.log(`  ${r.score?.toFixed(1)}  ${r.company} — ${r.title}`);
  console.log(`  ${r.url}`);

  // The same job, advertised again. Shown rather than hidden: the grouping is
  // a guess, and a wrong one silently costs an opportunity.
  const others = r.role_id ? postingsInRole(r.role_id).filter((p) => p.id !== r.id) : [];
  if (others.length) {
    console.log(`\n  also advertised as ${others.length} other listing${others.length === 1 ? '' : 's'}:`);
    for (const o of others.slice(0, 8)) {
      console.log(`    ${qualifierOf(o.title) || o.title}${o.location ? ` · ${o.location}` : ''}`);
    }
    if (others.length > 8) console.log(`    ... and ${others.length - 8} more`);
  }

  const contacts = q<{ name: string; title: string; profile_url: string; context: string }>(
    'SELECT name, title, profile_url, context FROM contacts WHERE job_id = ?', r.id,
  );
  if (contacts.length) {
    for (const c of contacts) {
      console.log(`\n  → ${c.name}${c.title ? ` — ${c.title}` : ''}`);
      if (c.profile_url) console.log(`    ${c.profile_url}`);
      if (c.context) console.log(`    context: ${c.context}`);
    }
  } else {
    console.log('\n  → no contact identified yet');
  }

  const drafts = q<{ kind: string; body: string }>(
    'SELECT kind, body FROM drafts WHERE job_id = ?', r.id,
  );
  for (const d of drafts) {
    console.log(`\n  ${d.kind} (${d.body.length} chars):\n`);
    console.log(d.body.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  const already = outcomesFor(r.id);
  if (already.length) {
    console.log(`\n  already recorded: ${already.map((o) => o.outcome ?? 'sent').join(', ')}`);
  }
  console.log(`\n  when done:  npm run queue -- --sent ${r.id}\n`);
}

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
import { q, setState, postingsInRole } from './store/db.js';
import { qualifierOf } from './roles/key.js';
import { loadConfig } from './config-file.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const sent = flag('--sent');
const skip = flag('--skip');

if (sent) {
  setState(sent, 'sent');
  console.log(`\n  ${sent} marked sent.\n`);
  process.exit(0);
}
if (skip) {
  setState(skip, 'skipped');
  console.log(`\n  ${skip} skipped.\n`);
  process.exit(0);
}

const config = loadConfig();
// One entry per ROLE, not per posting. Variants sit in the `variant` state and
// are listed underneath rather than competing for a slot — Bjak alone would
// otherwise fill the whole day's queue with one job advertised eight ways.
const rows = q<{
  id: string; company: string; title: string; score: number; url: string; state: string;
  role_id: string | null;
}>(
  `SELECT id, company, title, score, url, state, role_id FROM jobs
   WHERE state IN ('scored', 'enriched', 'queued')
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
  console.log(`\n  when done:  npm run queue -- --sent ${r.id}\n`);
}

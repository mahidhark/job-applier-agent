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
import { q, setState } from './store/db.js';
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
const rows = q<{
  id: string; company: string; title: string; score: number; url: string; state: string;
}>(
  `SELECT id, company, title, score, url, state FROM jobs
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

/**
 * Why one posting was skipped — including never having been seen.
 *
 *   npm run explain -- <job-id>
 *
 * "It never came back from any source" is a real answer and a different bug
 * from "it failed a gate": the first is a discovery problem, the second a
 * rubric one. Conflating them sends you to the wrong file.
 */
import { q } from './store/db.js';

const [id] = process.argv.slice(2);
if (!id) {
  console.error('\n  usage: npm run explain -- <job-id>\n');
  process.exit(1);
}

const job = q<{ title: string; company: string; state: string; score: number | null; url: string; first_seen: string }>(
  'SELECT title, company, state, score, url, first_seen FROM jobs WHERE id = ?', id,
)[0];

if (!job) {
  console.log(`\n  ${id} has never been seen.\n`);
  console.log('  No source returned it, so no gate ever ran. That is a discovery gap,');
  console.log('  not a screening one — look at config/sources/, not the gates.\n');
  process.exit(0);
}

console.log(`\n  ${job.company} — ${job.title}`);
console.log(`  ${job.url}`);
console.log(`  state ${job.state}${job.score != null ? `, score ${job.score}` : ''}, first seen ${job.first_seen}\n`);

const gates = q<{ gate: string; passed: number; detail: string }>(
  'SELECT gate, passed, detail FROM gates WHERE job_id = ? ORDER BY passed, gate', id,
);
for (const g of gates) console.log(`    ${g.passed ? 'pass' : 'FAIL'}  ${g.gate.padEnd(22)} ${g.detail ?? ''}`);

const contacts = q<{ name: string; title: string; profile_url: string }>(
  'SELECT name, title, profile_url FROM contacts WHERE job_id = ?', id,
);
if (contacts.length) {
  console.log('\n  CONTACTS');
  for (const c of contacts) console.log(`    ${c.name} — ${c.title ?? '?'}\n      ${c.profile_url ?? ''}`);
}
console.log();

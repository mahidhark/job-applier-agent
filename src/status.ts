/** One-shot report: what the agent has seen, kept, and why it rejected the rest. */
import { q, spentLast24h, outreachRates, ratePct } from './store/db.js';

const rule = (label: string) => console.log(`\n${'─'.repeat(72)}\n  ${label}\n`);

const states = q<{ state: string; n: number }>(
  'SELECT state, COUNT(*) AS n FROM jobs GROUP BY state ORDER BY n DESC',
);
rule('STATES');
if (!states.length) console.log('  nothing seen yet — run `npm run poll:once`');
for (const s of states) console.log(`  ${String(s.n).padStart(5)}  ${s.state}`);

rule('WHY POSTINGS WERE REJECTED');
const gates = q<{ gate: string; n: number; example: string }>(
  `SELECT gate, COUNT(*) AS n, detail AS example FROM gates
   WHERE passed = 0 GROUP BY gate ORDER BY n DESC LIMIT 10`,
);
for (const g of gates) console.log(`  ${String(g.n).padStart(5)}  ${g.gate.padEnd(22)} e.g. ${g.example ?? ''}`);

/**
 * The first honest scoreboard this project has had.
 *
 * The denominator is outreach recorded as SENT in the window. A row with no
 * `sent_at` is a reply captured opportunistically — sent before this table
 * existed, or outside the system — so it is reported separately rather than
 * deflating a rate with outreach nobody measured.
 *
 * A zero denominator prints `—`, never `0%`: no outreach and no acceptances
 * are the same number and mean opposite things.
 */
rule('OUTREACH, LAST 30 DAYS');
const r30 = outreachRates(30);
const pct = (n: number) => ratePct(n, r30.sent);
if (!r30.sent && !r30.unsent) {
  console.log('  nothing recorded yet — `npm run queue -- --sent <id>` after you message someone');
} else {
  console.log(`  ${String(r30.sent).padStart(5)}  sent`);
  console.log(`  ${String(r30.accepted).padStart(5)}  accepted     ${pct(r30.accepted)}`);
  console.log(`  ${String(r30.replied).padStart(5)}  replied      ${pct(r30.replied)}`);
  console.log(`  ${String(r30.declined).padStart(5)}  declined     ${pct(r30.declined)}`);
  if (r30.unsent) {
    console.log(`\n  ${String(r30.unsent).padStart(5)}  recorded with no send date (not in the rates above)`);
  }
}

rule('TOP SCORED, NOT YET CONTACTED');
const top = q<{ company: string; title: string; score: number; url: string }>(
  `SELECT company, title, score, url FROM jobs
   WHERE state = 'scored' AND id NOT IN (SELECT job_id FROM outcomes)
   ORDER BY score DESC LIMIT 10`,
);
for (const t of top) console.log(`  ${t.score?.toFixed(1).padStart(5)}  ${t.company} — ${t.title}\n         ${t.url}`);

rule('SPEND');
console.log(`  $${spentLast24h().toFixed(3)} in the last 24 hours (estimated)\n`);

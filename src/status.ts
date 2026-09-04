/** One-shot report: what the agent has seen, kept, and why it rejected the rest. */
import { q, spentLast24h } from './store/db.js';

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

rule('TOP SCORED, NOT YET QUEUED');
const top = q<{ company: string; title: string; score: number; url: string }>(
  `SELECT company, title, score, url FROM jobs
   WHERE state = 'scored' ORDER BY score DESC LIMIT 10`,
);
for (const t of top) console.log(`  ${t.score?.toFixed(1).padStart(5)}  ${t.company} — ${t.title}\n         ${t.url}`);

rule('SPEND');
console.log(`  $${spentLast24h().toFixed(3)} in the last 24 hours (estimated)\n`);

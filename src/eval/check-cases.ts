/**
 * Is the case set fit to score against?
 *
 *   npm run cases:check
 *
 * Refuses a set that cannot measure the things that matter: fabrication, and
 * whether a tuning change generalised.
 */
import { loadCases, validateCases, CASES_PATH } from './cases.js';

const cases = loadCases();
const problems = validateCases(cases);

console.log(`\n  ${cases.length} cases in ${CASES_PATH}\n`);

const byShape = cases.reduce<Record<string, number>>((acc, c) => {
  acc[c.shape] = (acc[c.shape] ?? 0) + 1;
  return acc;
}, {});
for (const [shape, n] of Object.entries(byShape)) console.log(`    ${String(n).padStart(3)}  ${shape}`);
const tune = cases.filter((c) => c.split === 'tune').length;
console.log(`\n    ${tune} tune / ${cases.length - tune} holdout`);

if (!problems.length) {
  console.log('\n  Ready. Run: npm run experiment\n');
  process.exit(0);
}

console.log(`\n  ${problems.length} problem(s):\n`);
for (const p of problems) console.log(`    ${p.jobId.padEnd(28)} ${p.problem}`);
console.log();
process.exit(1);

/**
 * Build a grading sheet so labelling ten cases takes minutes, not an hour.
 *
 *   npm run cases:prepare -- --n 10
 *
 * Fills in everything verifiable — posting, company, resolved LinkedIn URL, and
 * the people the tools can actually see — and leaves exactly two things blank
 * for a human: which contacts are acceptable, and why.
 *
 * It deliberately does NOT suggest an answer. If it pre-filled a best guess,
 * grading would collapse into agreeing with the machine, and the case set would
 * measure whether the agent agrees with me rather than whether it is right.
 */
import { q, recordActorCall, recordSpend, spentLast24h } from '../store/db.js';
import { loadConfig } from '../config-file.js';
import { runActorViaMcp, closeMcp } from '../agent/apify.js';
import { profileLabel, type RawProfile } from '../agent/profile.js';
import { saveCases, CASES_PATH, type EvalCase } from './cases.js';
import type { JobPosting } from '../sources/types.js';

const args = process.argv.slice(2);
const nIdx = args.indexOf('--n');
const N = nIdx >= 0 ? Number(args[nIdx + 1]) : 10;

const COMPANY_SEARCH = 'harvestapi/linkedin-company';
const PROFILE_SEARCH = 'harvestapi/linkedin-profile-search';
const COMPANY_EMPLOYEES = 'harvestapi/linkedin-company-employees';

/**
 * Declared price per call — the same figures the agent's tools charge against
 * their run budget.
 *
 * THIS FILE USED TO SPEND AND RECORD NOTHING. It called the actors directly,
 * wrote no `spend` row and consulted no ceiling, so `npm run status` reported
 * $0.000 after a dollar and a half had gone, and the daily guard could neither
 * see it nor refuse it. It was the only paid path in the repo that did not
 * declare its price, against a design rule that says every one must.
 */
const ACTOR_COST_USD: Record<string, number> = {
  [COMPANY_SEARCH]: 0.005,
  [PROFILE_SEARCH]: 0.14,
  [COMPANY_EMPLOYEES]: 0.10,
};

/** Charge for a call before making it, and refuse at the daily ceiling. */
function makeCharger() {
  const budget = loadConfig().enrich.maxSpendPerDayUsd;
  const already = spentLast24h('enrich');
  let spent = 0;
  return {
    budget,
    already,
    get spent() { return spent; },
    /** False when this call would cross the ceiling. Refused, not billed. */
    charge(actor: string, note: string): boolean {
      const cost = ACTOR_COST_USD[actor] ?? 0;
      if (already + spent + cost > budget) return false;
      spent += cost;
      recordSpend(actor, cost, note, 'enrich');
      return true;
    },
  };
}

interface CompanyHit { name?: string; linkedinUrl?: string; employeeCount?: number }

async function peopleAt(url: string, charger: ReturnType<typeof makeCharger>): Promise<string[]> {
  // Try both sources. Which one answers is not the point here; seeing who
  // exists is, and one source was down for the whole of 2026-09-04.
  for (const [actor, input] of [
    // FULL, NOT SHORT — the same mode the agent's tools use.
    //
    // Short returns an opaque `/in/ACwAAA...` member id where the profile URL
    // belongs. `record_contact` REFUSES those, so the agent can only ever
    // commit a real vanity URL — while `right_contact` matches on URL. A sheet
    // graded from Short-mode links therefore scores every case 0, and reads as
    // the model failing.
    //
    // PR #4 fixed this in `agent/tools/index.ts` and this file was never
    // updated. The drift cost $1.05 and a case set that could not measure
    // anything; `sameScraperMode` in the test suite now watches for it.
    //
    // The enum trap is real: PROFILE_SEARCH takes a plain 'Full', while
    // COMPANY_EMPLOYEES carries the price inside the value. Same field name,
    // same publisher, different valid values.
    [PROFILE_SEARCH, { profileScraperMode: 'Full', currentCompanies: [url], maxItems: 10 }],
    [COMPANY_EMPLOYEES, { profileScraperMode: 'Full ($8 per 1k)', companies: [url], maxItems: 10 }],
  ] as const) {
    if (!charger.charge(actor, `cases:${url}`)) {
      console.error(`\n  ! daily enrichment budget reached — stopping before ${actor}\n`);
      break;
    }
    try {
      const rows = (await runActorViaMcp(actor, input, 10)) as RawProfile[];
      recordActorCall(actor, rows.length);
      if (rows.length) return rows.map(profileLabel);
    } catch {
      recordActorCall(actor, 0, true);
    }
  }
  return [];
}

async function main() {
  // ONE POSTING PER COMPANY, best-scored within each.
  //
  // Plain `ORDER BY score DESC LIMIT 10` returned ten Bjak roles, because Bjak
  // scores highest and advertises most. A set like that cannot test
  // `ambiguous_company` at all, is unlikely to contain the two mandatory
  // `nobody_findable` cases, and exercises company resolution once instead of
  // ten times — while costing the same money as a set that works.
  //
  // §2.1 says coverage is by SHAPE, not count. Ten postings at one company is
  // worse than ten easy ones: it is one case, paid for ten times.
  const rows = q<{ id: string; raw: string; score: number }>(
    `SELECT id, raw, score FROM jobs j
      WHERE state = 'scored'
        AND score = (SELECT MAX(score) FROM jobs x WHERE x.state = 'scored' AND x.company = j.company)
      GROUP BY j.company
      ORDER BY score DESC LIMIT ?`,
    N,
  );
  if (!rows.length) {
    console.error('\n  No scored postings. Run `npm run poll:once` first.\n');
    process.exit(1);
  }

  const charger = makeCharger();
  const worst = rows.length * (ACTOR_COST_USD[COMPANY_SEARCH]! + ACTOR_COST_USD[PROFILE_SEARCH]!
                             + ACTOR_COST_USD[COMPANY_EMPLOYEES]!);
  console.log(
    `\n  Preparing ${rows.length} cases across ${new Set(rows.map((r) => (JSON.parse(r.raw) as JobPosting).company)).size} companies.\n` +
    `  At most $${worst.toFixed(2)}; $${charger.already.toFixed(2)} of the ` +
    `$${charger.budget.toFixed(2)} daily budget is already spent.\n`,
  );
  const cases: EvalCase[] = [];

  for (const [i, r] of rows.entries()) {
    const job = JSON.parse(r.raw) as JobPosting;
    process.stdout.write(`  ${job.company} — ${job.title.slice(0, 45)} ... `);

    let companyUrl = job.companyLinkedinUrl;
    if (!companyUrl) {
      if (charger.charge(COMPANY_SEARCH, `cases:${job.company}`)) {
        try {
          const hits = (await runActorViaMcp(COMPANY_SEARCH, { searches: [job.company] }, 3)) as CompanyHit[];
          recordActorCall(COMPANY_SEARCH, hits.length);
          companyUrl = hits[0]?.linkedinUrl ?? null;
        } catch {
          recordActorCall(COMPANY_SEARCH, 0, true);
        }
      }
    }

    const candidates = companyUrl ? await peopleAt(companyUrl, charger) : [];
    console.log(`${candidates.length} people visible`);

    cases.push({
      jobId: job.id,
      company: job.company,
      title: job.title,
      companyName: job.company,
      companyLinkedinUrl: companyUrl,
      // Left for a human. `names_nobody` is a placeholder, not a guess at the
      // answer — the shape still has to be judged against the posting.
      shape: 'names_nobody',
      acceptable: [],
      reason: '',
      split: i < Math.ceil(rows.length * 0.7) ? 'tune' : 'holdout',
      candidatesSeen: candidates,
    });
  }

  saveCases(cases);
  await closeMcp();

  console.log(`\n  Wrote ${cases.length} cases to ${CASES_PATH}`);
  console.log(`  Spent $${charger.spent.toFixed(3)} — recorded, and visible in npm run status.\n`);
  console.log('  For each case, fill in:');
  console.log('    shape       names_nobody | names_recruiter | ambiguous_company | nobody_findable');
  console.log('    acceptable  [{ name, profileUrl }] — every contact that would be a good answer');
  console.log('                leave empty when the shape is nobody_findable');
  console.log('    reason      one line on why\n');
  console.log('  At least two cases must be nobody_findable, or nothing ever tests');
  console.log('  whether the agent invents a person. Then run: npm run cases:check\n');
}

main().catch(async (err) => {
  await closeMcp();
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

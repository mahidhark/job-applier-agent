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
import { q, recordActorCall } from '../store/db.js';
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

interface CompanyHit { name?: string; linkedinUrl?: string; employeeCount?: number }

async function peopleAt(url: string): Promise<string[]> {
  // Try both sources. Which one answers is not the point here; seeing who
  // exists is, and one source was down for the whole of 2026-09-04.
  for (const [actor, input] of [
    [PROFILE_SEARCH, { profileScraperMode: 'Short', currentCompanies: [url], maxItems: 10 }],
    [COMPANY_EMPLOYEES, { profileScraperMode: 'Short ($4 per 1k)', companies: [url], maxItems: 10 }],
  ] as const) {
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
  const rows = q<{ id: string; raw: string; score: number }>(
    `SELECT id, raw, score FROM jobs WHERE state = 'scored' ORDER BY score DESC LIMIT ?`,
    N,
  );
  if (!rows.length) {
    console.error('\n  No scored postings. Run `npm run poll:once` first.\n');
    process.exit(1);
  }

  console.log(`\n  Preparing ${rows.length} cases. This spends Apify credit.\n`);
  const cases: EvalCase[] = [];

  for (const [i, r] of rows.entries()) {
    const job = JSON.parse(r.raw) as JobPosting;
    process.stdout.write(`  ${job.company} — ${job.title.slice(0, 45)} ... `);

    let companyUrl = job.companyLinkedinUrl;
    if (!companyUrl) {
      try {
        const hits = (await runActorViaMcp(COMPANY_SEARCH, { searches: [job.company] }, 3)) as CompanyHit[];
        recordActorCall(COMPANY_SEARCH, hits.length);
        companyUrl = hits[0]?.linkedinUrl ?? null;
      } catch {
        recordActorCall(COMPANY_SEARCH, 0, true);
      }
    }

    const candidates = companyUrl ? await peopleAt(companyUrl) : [];
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

  console.log(`\n  Wrote ${cases.length} cases to ${CASES_PATH}\n`);
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

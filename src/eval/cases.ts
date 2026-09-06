/**
 * The case set: postings whose right answer is already known.
 *
 * This is the foundation of every score. Without it the harness can report that
 * one model took five tool calls and another ten, and nothing about whether
 * either found the right person.
 *
 * The answers are Mahi's judgement, not ground truth — nobody has ground truth
 * until a reply arrives, which is months away. That is a known and accepted
 * limit (sprint-01-plan §7.10): his judgement is the best signal available now,
 * and real outcomes correct it later.
 *
 * Cases live outside git. They name real people who did not consent to being in
 * a dataset.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isResolvableProfileUrl } from '../agent/profile.js';

export const CASES_PATH = process.env['JOB_AGENT_CASES'] ?? 'data/cases/cases.json';

/**
 * What makes a case hard. Coverage is by shape, not count — ten easy postings
 * measure nothing.
 */
export type CaseShape =
  /** The posting names nobody. The agent must find the company, then the person. */
  | 'names_nobody'
  /** The poster is a recruiter; the right answer is someone else. */
  | 'names_recruiter'
  /** Several companies share the name; picking the wrong one is the failure. */
  | 'ambiguous_company'
  /**
   * Nobody is reachable. The correct answer is record_no_contact.
   * An agent that names a person here FAILS — and fabricating a contact is the
   * worst thing this system can do, so at least two cases must be this shape.
   */
  | 'nobody_findable';

export interface AcceptableContact {
  name: string;
  /** LinkedIn profile URL. The scorer matches on this, case-insensitively. */
  profileUrl: string;
}

export interface EvalCase {
  jobId: string;
  company: string;
  title: string;
  /** Both are stored: a company can be renamed, and then the URL points nowhere. */
  companyName: string;
  companyLinkedinUrl: string | null;
  shape: CaseShape;
  /**
   * Every contact that would be a good answer. More than one is normal — a Head
   * of Product and a founder at a 60-person company are both defensible, and a
   * single expected answer marks one of them wrong.
   * Empty means the correct answer is "nobody".
   */
  acceptable: AcceptableContact[];
  /** Why these are right. Free text, for reading a failure later. */
  reason: string;
  /** Tuning happens on `tune`; `holdout` only ever confirms a change generalised. */
  split: 'tune' | 'holdout';
  /** Filled by prepare-cases, for context while grading. */
  candidatesSeen?: string[];
}

export interface CaseFile {
  version: 1;
  createdAt: string;
  cases: EvalCase[];
}

export function loadCases(path = CASES_PATH): EvalCase[] {
  if (!existsSync(path)) {
    throw new Error(
      `no case set at ${path}. Run \`npm run cases:prepare\`, fill in the sheet, ` +
      `then \`npm run cases:check\`.`,
    );
  }
  const file = JSON.parse(readFileSync(path, 'utf8')) as CaseFile;
  return file.cases;
}

export function saveCases(cases: EvalCase[], path = CASES_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const file: CaseFile = { version: 1, createdAt: new Date().toISOString(), cases };
  writeFileSync(path, JSON.stringify(file, null, 2));
}

export interface CaseProblem {
  jobId: string;
  problem: string;
}

/**
 * What must be true before a case set is worth scoring against.
 *
 * These are not style rules. A set with no `nobody_findable` cases never tests
 * for fabrication, and a set with no holdout lets tuning fit the labels and
 * call it progress.
 */
export function validateCases(cases: EvalCase[]): CaseProblem[] {
  const problems: CaseProblem[] = [];
  const seen = new Set<string>();

  for (const c of cases) {
    if (seen.has(c.jobId)) problems.push({ jobId: c.jobId, problem: 'duplicate case' });
    seen.add(c.jobId);

    if (c.shape === 'nobody_findable') {
      if (c.acceptable.length) {
        problems.push({
          jobId: c.jobId,
          problem: 'shape is nobody_findable but acceptable contacts are listed',
        });
      }
    } else if (!c.acceptable.length) {
      problems.push({ jobId: c.jobId, problem: `shape is ${c.shape} but no acceptable contact given` });
    }

    for (const a of c.acceptable) {
      // NOT just "is it a linkedin.com/in/ URL".
      //
      // An opaque `/in/ACwAAA...` member id passes that test and is still
      // unusable: `record_contact` refuses to commit one, so the agent can only
      // ever answer with a vanity URL, and `right_contact` matches on URL. A
      // case graded against a member id can therefore never be passed by any
      // model, however right it is.
      //
      // This is checked HERE, before grading, because the alternative is
      // discovering it after twenty minutes of a human's judgement has gone
      // into a sheet that cannot score anything.
      if (!isResolvableProfileUrl(a.profileUrl)) {
        problems.push({
          jobId: c.jobId,
          problem: /linkedin\.com\/in\//i.test(a.profileUrl)
            ? `"${a.profileUrl.slice(0, 48)}..." is an opaque member id, not a profile URL — ` +
              `nothing can ever match it. Re-run cases:prepare in Full mode.`
            : `"${a.profileUrl}" is not a LinkedIn profile URL`,
        });
      }
    }
    if (!c.reason.trim()) problems.push({ jobId: c.jobId, problem: 'no reason given' });
  }

  const none = cases.filter((c) => c.shape === 'nobody_findable').length;
  if (none < 2) {
    problems.push({
      jobId: '(set)',
      problem: `${none} nobody_findable case(s); at least 2 needed, or nothing ever ` +
               `tests whether the agent invents a contact`,
    });
  }
  const holdout = cases.filter((c) => c.split === 'holdout').length;
  if (holdout < 2) {
    problems.push({
      jobId: '(set)',
      problem: `${holdout} holdout case(s); at least 2 needed, or tuning fits the labels`,
    });
  }
  return problems;
}

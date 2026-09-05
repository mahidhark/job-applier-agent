/**
 * LinkedIn job discovery through Apify.
 *
 * This is the only source that costs money, so it is deliberately the thinnest
 * one: title, company, location and enough to run the gates. Everything
 * expensive — the job poster, company detail, the person's recent posts —
 * happens in src/enrich, and only for postings that already passed.
 *
 * Two field-level warnings, both measured on a live run 2026-09-04:
 *
 *   applicantsCount is BUCKETED. Five postings returned 25, 179, 25, 25, 112.
 *   A 25 means "25 or unknown". It is carried through as a weak ranking signal
 *   and must never become a gate.
 *
 *   jobPoster* populate on roughly 40% of postings, and when present are as
 *   often a recruiter as the hiring manager. Treat as a lead, not an answer.
 */
import type { AgentConfig } from '../../config-file.js';
import { recordSpend } from '../../store/db.js';

/**
 * LinkedIn's own duration codes, which is what the actor demands.
 *
 * `past24Hours` is rejected with
 *   "Field input.datePosted must be equal to one of the allowed values:
 *    \"\", \"r2592000\", \"r604800\", \"r86400\""
 *
 * The config kept the readable names and passed them straight through, so
 * EVERY paid discovery call has failed since this source was written — 3,088
 * postings in the store, all of them from the two free ATS boards, and zero
 * discovery spend ever recorded. The per-source try/catch turned a total
 * outage into one warning line per pass.
 *
 * Config keeps the readable names and this maps them, because `r2592000` in a
 * config file is a thing nobody can check by reading.
 */
export const DATE_POSTED: Record<string, string> = {
  anyTime: '',
  past24Hours: 'r86400',
  pastWeek: 'r604800',
  pastMonth: 'r2592000',
};
import { runActorForItems } from './client.js';
import type { JobPosting, Source } from '../types.js';

interface LinkedinJob {
  id?: string;
  title?: string;
  companyName?: string;
  location?: string;
  postedAt?: string;
  descriptionText?: string;
  link?: string;
  seniorityLevel?: string;
  employmentType?: string;
  jobFunction?: string;
  salary?: string;
  applicantsCount?: string;
  companyEmployeesCount?: number;
  companyWebsite?: string;
  companyLinkedinUrl?: string;
  jobPosterName?: string;
  jobPosterTitle?: string;
  jobPosterProfileUrl?: string;
}

/** "25" -> 25, "" -> null. See the bucketing warning above. */
const count = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(String(s).replace(/[^0-9]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function linkedinSource(config: AgentConfig): Source {
  const { discoveryActor, searches } = config.searches;

  return {
    name: 'linkedin',
    paid: true,
    async fetch(): Promise<JobPosting[]> {
      const all: JobPosting[] = [];

      for (const s of searches) {
        const input: Record<string, unknown> = {
          keywords: s.keywords,
          location: s.location,
          limit: s.limit,
          limitPerSource: s.limit,
          scrapeCompany: false,
        };
        if (s.datePosted) input['datePosted'] = DATE_POSTED[s.datePosted]!;
        if (s.under10Applicants) input['under10Applicants'] = true;

        const rows = await runActorForItems<LinkedinJob>(discoveryActor, input, { limit: s.limit });

        // Rough, and deliberately so — the exact figure comes from Apify's
        // billing. This exists to enforce a daily ceiling, not to invoice.
        recordSpend(discoveryActor, rows.length * 0.0004 + 0.001, s.name, 'discover');

        for (const j of rows) {
          if (!j.id) continue;
          all.push({
            id: `linkedin:${j.id}`,
            source: 'linkedin',
            sourceId: j.id,
            title: j.title ?? '',
            company: j.companyName ?? '',
            location: j.location ?? null,
            remote: j.location ? /remote/i.test(j.location) : null,
            description: j.descriptionText ?? '',
            url: j.link ?? '',
            postedAt: j.postedAt ?? null,
            employmentType: j.employmentType ?? null,
            seniority: j.seniorityLevel ?? null,
            department: j.jobFunction ?? null,
            salaryMin: null,
            salaryMax: null,
            companySize: j.companyEmployeesCount ?? null,
            companyUrl: j.companyWebsite ?? null,
            companyLinkedinUrl: j.companyLinkedinUrl ?? null,
            contactName: j.jobPosterName ?? null,
            contactTitle: j.jobPosterTitle ?? null,
            contactProfileUrl: j.jobPosterProfileUrl ?? null,
            applicantCount: count(j.applicantsCount),
          });
        }
      }
      return all;
    },
  };
}

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
import { runActor, datasetItems } from './client.js';
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
        if (s.datePosted) input['datePosted'] = s.datePosted;
        if (s.under10Applicants) input['under10Applicants'] = true;

        const run = await runActor(discoveryActor, input);
        const rows = await datasetItems<LinkedinJob>(run.datasetId, s.limit);

        // Rough, and deliberately so — the exact figure comes from Apify's
        // billing. This exists to enforce a daily ceiling, not to invoice.
        recordSpend(discoveryActor, rows.length * 0.0004 + 0.001, s.name);

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

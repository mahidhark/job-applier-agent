/**
 * Ashby public job board API. Free, no key, no scraping.
 *
 *   https://api.ashbyhq.com/posting-api/job-board/<slug>
 *
 * Verified live against `bjakcareer` on 2026-09-04. The response is the whole
 * board in one document — 3,084 postings for that slug — so filtering happens
 * here rather than in the request.
 */
import { toPlainText, type JobPosting, type Source } from '../types.js';

interface AshbyJob {
  id?: string;
  title?: string;
  location?: string;
  isRemote?: boolean;
  employmentType?: string;
  department?: string;
  team?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  jobUrl?: string;
  applyUrl?: string;
  publishedAt?: string;
  updatedAt?: string;
  compensation?: { compensationTierSummary?: string } | null;
  secondaryLocations?: Array<{ location?: string }>;
}

export function ashbySource(company: string, slug: string): Source {
  return {
    name: 'ashby',
    paid: false,
    async fetch(): Promise<JobPosting[]> {
      const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error(`ashby ${slug}: HTTP ${res.status}`);
      const body = (await res.json()) as { jobs?: AshbyJob[] };

      return (body.jobs ?? []).map((j) => ({
        id: `ashby:${j.id ?? ''}`,
        source: 'ashby' as const,
        sourceId: j.id ?? '',
        title: j.title ?? '',
        company,
        location: j.location ?? null,
        remote: j.isRemote ?? null,
        description: j.descriptionPlain ?? toPlainText(j.descriptionHtml),
        url: j.jobUrl ?? j.applyUrl ?? '',
        postedAt: j.publishedAt ?? j.updatedAt ?? null,
        employmentType: j.employmentType ?? null,
        seniority: null,
        department: j.department ?? j.team ?? null,
        // Ashby exposes compensation as a prose summary rather than numbers.
        // Parsing it is the salary parser's job, not this adapter's.
        salaryMin: null,
        salaryMax: null,
        companySize: null,
        companyUrl: null,
        companyLinkedinUrl: null,
        contactName: null,
        contactTitle: null,
        contactProfileUrl: null,
        applicantCount: null,
      }));
    },
  };
}

/**
 * Lever postings API. Free, no key.
 *
 *   https://api.lever.co/v0/postings/<slug>?mode=json
 *
 * Returns a bare array rather than an object, unlike Ashby and Greenhouse.
 */
import { toPlainText, type JobPosting, type Source } from '../types.js';

interface LeverPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  descriptionPlain?: string;
  description?: string;
  categories?: { commitment?: string; location?: string; team?: string; department?: string };
  workplaceType?: string;
}

export function leverSource(company: string, slug: string): Source {
  return {
    name: 'lever',
    paid: false,
    async fetch(): Promise<JobPosting[]> {
      const res = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
      if (!res.ok) throw new Error(`lever ${slug}: HTTP ${res.status}`);
      const body = (await res.json()) as LeverPosting[];

      return (Array.isArray(body) ? body : []).map((j) => ({
        id: `lever:${j.id ?? ''}`,
        source: 'lever' as const,
        sourceId: j.id ?? '',
        title: j.text ?? '',
        company,
        location: j.categories?.location ?? null,
        remote: j.workplaceType ? /remote/i.test(j.workplaceType) : null,
        description: j.descriptionPlain ?? toPlainText(j.description),
        url: j.hostedUrl ?? j.applyUrl ?? '',
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        employmentType: j.categories?.commitment ?? null,
        seniority: null,
        department: j.categories?.team ?? j.categories?.department ?? null,
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

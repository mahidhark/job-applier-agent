/**
 * Greenhouse job board API. Free, no key.
 *
 *   https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true
 *
 * `content=true` returns HTML-escaped job content; without it you get titles
 * only and a second call per job. One call for the board is cheaper.
 */
import { toPlainText, type JobPosting, type Source } from '../types.js';

interface GreenhouseJob {
  id?: number;
  title?: string;
  /** When the posting first went live. Prefer this over updated_at, which
   *  moves whenever anyone edits a typo and would make a stale role look new. */
  first_published?: string;
  updated_at?: string;
  company_name?: string;
  absolute_url?: string;
  content?: string;
  location?: { name?: string };
  departments?: Array<{ name?: string }>;
  metadata?: Array<{ name?: string; value?: unknown }>;
}

/** Greenhouse double-escapes `content`; unescape before stripping tags. */
const unescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

export function greenhouseSource(company: string, slug: string): Source {
  return {
    name: 'greenhouse',
    paid: false,
    async fetch(): Promise<JobPosting[]> {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`greenhouse ${slug}: HTTP ${res.status}`);
      const body = (await res.json()) as { jobs?: GreenhouseJob[] };

      return (body.jobs ?? []).map((j) => ({
        id: `greenhouse:${j.id ?? ''}`,
        source: 'greenhouse' as const,
        sourceId: String(j.id ?? ''),
        title: j.title ?? '',
        company: j.company_name ?? company,
        location: j.location?.name ?? null,
        remote: /remote/i.test(j.location?.name ?? '') || null,
        description: toPlainText(unescape(j.content ?? '')),
        url: j.absolute_url ?? '',
        postedAt: j.first_published ?? j.updated_at ?? null,
        employmentType: null,
        seniority: null,
        department: j.departments?.[0]?.name ?? null,
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

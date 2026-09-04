/**
 * The one shape every source normalises to.
 *
 * Sources disagree about almost everything — Greenhouse gives HTML content and
 * a location string, Ashby gives plain text and a boolean `isRemote`, LinkedIn
 * gives an applicant count that is bucketed rather than measured. Normalising
 * at the edge means the gates, scorer and drafter never learn which board a
 * posting came from.
 *
 * Every optional field is optional because at least one real source omits it.
 * Nothing downstream may assume a field is present.
 */
export interface JobPosting {
  /** Stable across polls. `${source}:${sourceId}` so two boards cannot collide. */
  id: string;
  source: SourceName;
  sourceId: string;

  title: string;
  company: string;
  /** Free text as the board wrote it: "Amsterdam, NL", "Remote - Europe". */
  location: string | null;
  remote: boolean | null;
  /** Plain text. HTML is stripped at the edge so gates can regex it safely. */
  description: string;
  url: string;
  /** ISO 8601. Null when the board does not publish one. */
  postedAt: string | null;

  employmentType: string | null;
  seniority: string | null;
  department: string | null;

  /** Annual, in `salaryCurrency`. Most boards publish nothing. */
  salaryMin: number | null;
  salaryMax: number | null;

  companySize: number | null;
  companyUrl: string | null;
  /** Chains into the people search, which filters by company URL, not name. */
  companyLinkedinUrl: string | null;

  /**
   * Whoever LinkedIn names as having posted the job. Present roughly 40% of
   * the time in practice, and when present is as likely to be a recruiter as
   * the hiring manager — check `contactTitle` before believing it.
   */
  contactName: string | null;
  contactTitle: string | null;
  contactProfileUrl: string | null;

  /**
   * CENSORED UPSTREAM. LinkedIn buckets this: a run of five postings returned
   * 25, 179, 25, 25, 112. A value of 25 means "25 or unknown", not twenty-five.
   * Usable as a weak signal, never as a gate.
   */
  applicantCount: number | null;
}

export type SourceName = 'ashby' | 'greenhouse' | 'lever' | 'recruitee' | 'linkedin';

/** What a board adapter must provide. Adding a board is adding one of these. */
export interface Source {
  name: SourceName;
  /** True when this source bills per result and should sit behind the gates. */
  paid: boolean;
  fetch(): Promise<JobPosting[]>;
}

export interface BoardConfig {
  company: string;
  ats: SourceName;
  slug: string;
}

/** Strip tags and collapse whitespace, so a gate regex sees prose not markup. */
export function toPlainText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

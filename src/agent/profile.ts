/**
 * One shape for a person, from either people-source.
 *
 * The two sources do NOT agree on field names, and the difference is not
 * cosmetic. `linkedin-profile-search` returns a self-written `headline`;
 * `linkedin-company-employees` has no such field at all — it returns `summary`
 * and a `currentPositions` array. Code that reads only `headline` renders every
 * person from the second source as "no headline" and silently throws the job
 * title away.
 *
 * That was live for a day. It meant that on the ONLY source that was working
 * — profile-search returned zero rows for every company including Booking.com
 * and Adyen — the agent was asked to tell a recruiter from a hiring manager
 * with no titles in front of it. That is the single judgement the agent exists
 * to make, and it was being made blind. It would have read as the model being
 * bad at the task.
 *
 * So normalising is not tidying. Whenever a second source answers the same
 * question, the shapes must be reconciled in one place or the fallback quietly
 * becomes worse than the thing it falls back to.
 */

/** A row as either actor returns it. Every field optional; sources disagree. */
export interface RawProfile {
  firstName?: string;
  lastName?: string;
  /** profile-search only: the self-written one-liner. */
  headline?: string;
  /** company-employees only: the profile's About text. */
  summary?: string;
  linkedinUrl?: string;
  location?: { linkedinText?: string };
  currentPositions?: Array<{
    title?: string;
    companyName?: string;
    current?: boolean;
    tenureAtCompany?: { numYears?: number; numMonths?: number };
  }>;
}

export interface Profile {
  name: string;
  /** Best available description of what they do. Never empty. */
  title: string;
  url: string;
  location: string;
  /** "9 years at Booking.com", when the source says. Empty otherwise. */
  tenure: string;
}

const firstLine = (s: string): string => {
  const line = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
};

/**
 * Title, in the order of how much it tells you.
 *
 * `headline` first because a person writes it themselves and it usually says
 * more than their formal title ("Head of Product, hiring" beats "Director").
 * Then the current position, which is what the second source actually has.
 * `summary` last and truncated: it is an About section, not a title, but a
 * first line of one beats nothing.
 */
function bestTitle(p: RawProfile): string {
  if (p.headline?.trim()) return p.headline.trim();

  const pos = p.currentPositions?.find((x) => x.current) ?? p.currentPositions?.[0];
  if (pos?.title?.trim()) {
    const title = pos.title.trim();
    const company = pos.companyName?.trim();
    // Titles often already name the employer ("Head of Booking.com for
    // Business"). Appending it again reads as noise to a person and costs a
    // small model context for nothing.
    const redundant = company && title.toLowerCase().includes(company.toLowerCase());
    return company && !redundant ? `${title} at ${company}` : title;
  }
  if (p.summary?.trim()) return firstLine(p.summary);
  return 'no title given';
}

/**
 * How long they have been there.
 *
 * Only the second source reports it, and it is worth surfacing rather than
 * dropping: at a company someone has been at for nine years, they are a
 * different kind of contact from someone who joined last month, and that is
 * exactly the call the agent is being asked to make.
 */
function tenureOf(p: RawProfile): string {
  const pos = p.currentPositions?.find((x) => x.current) ?? p.currentPositions?.[0];
  const t = pos?.tenureAtCompany;
  if (!t) return '';
  const years = t.numYears ?? 0;
  const months = t.numMonths ?? 0;
  if (years >= 1) return `${years} year${years === 1 ? '' : 's'} at the company`;
  if (months >= 1) return `${months} month${months === 1 ? '' : 's'} at the company`;
  return '';
}

export function normaliseProfile(p: RawProfile): Profile {
  return {
    name: `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || '(no name)',
    title: bestTitle(p),
    url: p.linkedinUrl?.trim() ?? '',
    location: p.location?.linkedinText?.trim() ?? '',
    tenure: tenureOf(p),
  };
}

/** What the agent reads. One person per block, title always present. */
export function renderProfiles(rows: RawProfile[]): string {
  return rows.map((raw) => {
    const p = normaliseProfile(raw);
    return [
      `${p.name} — ${p.title}`,
      p.url ? `  ${p.url}` : null,
      [p.location, p.tenure].filter(Boolean).join(' · ') || null,
    ].filter(Boolean).map((l, i) => (i === 0 ? l : l!.startsWith('  ') ? l : `  ${l}`)).join('\n');
  }).join('\n\n');
}

/** One line, for the grading sheet. */
export function profileLabel(raw: RawProfile): string {
  const p = normaliseProfile(raw);
  return `${p.name} — ${p.title}${p.tenure ? ` (${p.tenure})` : ''} — ${p.url || 'no url'}`;
}

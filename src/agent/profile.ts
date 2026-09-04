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
 * That was live for a day. It meant that on the ONLY source returning
 * anything — profile-search was answering zero rows for every company,
 * Booking.com and Adyen included — the agent was asked to tell a recruiter
 * from a hiring manager with no titles in front of it. That is the single
 * judgement the agent exists to make, and it was being made blind. It would
 * have read as the model being bad at the task.
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
  /** Full mode only: the vanity slug, e.g. "ingmarvandongen". */
  publicIdentifier?: string;
  /** Full mode only: LinkedIn's own #hiring badge. */
  hiring?: boolean;
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
  /** LinkedIn's own #hiring badge, when the source reports it. */
  hiring: boolean;
  /** False when this row is not good enough to judge or to act on. */
  usable: boolean;
  /** Why not, when `usable` is false. Empty otherwise. */
  unusableReason: string;
}

/**
 * A LinkedIn member id standing in for a profile slug.
 *
 * `linkedin-company-employees` in Short mode puts this in `linkedinUrl`
 * instead of the vanity slug, and the resulting URL does not resolve. It is
 * not a link anybody can open, so it must never reach the queue — and the
 * agent cannot discover that from inside its loop, because from there it looks
 * exactly like a URL. This is the "unverifiable" half of the rule: constrain
 * it in the tool rather than asking the model to judge it.
 */
const OPAQUE_MEMBER_ID = /\/in\/AC[A-Za-z0-9_-]{20,}/;

export function isResolvableProfileUrl(url: string): boolean {
  const u = url.trim();
  if (!u) return false;
  if (!/linkedin\.com\/in\//i.test(u)) return false;
  return !OPAQUE_MEMBER_ID.test(u);
}

const NO_TITLE = 'no title given';

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
  return NO_TITLE;
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

/**
 * Is this row good enough to act on?
 *
 * Two ways it is not, and both were live for a day:
 *   - no title, so there is nothing to judge a recruiter against a manager on
 *   - an unresolvable URL, so the answer cannot be acted on even if right
 *
 * Reported rather than dropped. A row with a name and a dead link is still
 * evidence that a person exists; it just cannot be the committed answer.
 */
function usability(name: string, title: string, url: string): { usable: boolean; reason: string } {
  const problems: string[] = [];
  if (name === '(no name)') problems.push('no name');
  if (title === NO_TITLE) problems.push('no job title');
  if (!isResolvableProfileUrl(url)) {
    problems.push(url ? 'a profile URL that does not resolve' : 'no profile URL');
  }
  return { usable: !problems.length, reason: problems.join(', ') };
}

export function normaliseProfile(p: RawProfile): Profile {
  const name = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || '(no name)';
  const title = bestTitle(p);
  const url = (p.linkedinUrl?.trim() ?? '') ||
    (p.publicIdentifier ? `https://www.linkedin.com/in/${p.publicIdentifier}` : '');
  const { usable, reason } = usability(name, title, url);
  return {
    name,
    title,
    url,
    location: p.location?.linkedinText?.trim() ?? '',
    tenure: tenureOf(p),
    hiring: p.hiring === true,
    usable,
    unusableReason: reason,
  };
}

/**
 * What the tools tell the model when the evidence came back thin.
 *
 * The model CAN judge "I have no titles, so I cannot pick between these" — it
 * just had no way to know that was unusual rather than normal. So it is told,
 * with numbers, and left to decide what to do about it.
 */
export function evidenceWarning(rows: RawProfile[]): string {
  const all = rows.map(normaliseProfile);
  const bad = all.filter((p) => !p.usable);
  if (!bad.length) return '';
  const noTitle = all.filter((p) => p.title === NO_TITLE).length;
  const noUrl = all.filter((p) => !isResolvableProfileUrl(p.url)).length;
  const parts: string[] = [];
  if (noTitle) parts.push(`${noTitle} of ${all.length} came back with no job title`);
  if (noUrl) parts.push(`${noUrl} of ${all.length} have a profile URL that will not open`);
  return `NOTE: ${parts.join(' and ')}. That is this source returning reduced data, ` +
         `not those people lacking jobs. Judge on what you can see, and prefer a ` +
         `candidate whose record is complete — an incomplete one cannot be committed.`;
}

/** What the agent reads. One person per block, title always present. */
export function renderProfiles(rows: RawProfile[]): string {
  const body = rows.map((raw) => {
    const p = normaliseProfile(raw);
    const facts = [p.location, p.tenure, p.hiring ? 'LinkedIn #hiring badge' : '']
      .filter(Boolean).join(' · ');
    return [
      `${p.name} — ${p.title}`,
      p.url ? `  ${p.url}` : null,
      facts ? `  ${facts}` : null,
      p.usable ? null : `  [incomplete: ${p.unusableReason} — cannot be committed as the answer]`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const warning = evidenceWarning(rows);
  return warning ? `${body}\n\n${warning}` : body;
}

/** One line, for the grading sheet. */
export function profileLabel(raw: RawProfile): string {
  const p = normaliseProfile(raw);
  return `${p.name} — ${p.title}${p.tenure ? ` (${p.tenure})` : ''} — ${p.url || 'no url'}`;
}

/**
 * Turning a job title into the identity of a role.
 *
 * One role gets advertised many times. Bjak posts a single Technical Product
 * Lead opening as eight rows:
 *
 *   Technical Product Lead - AI Finance
 *   Technical Product Lead - AI Finance App
 *   Technical Product Lead - AI Neobank App
 *   ... and five more
 *
 * The dedupe that already existed keyed on company plus EXACT title, so those
 * were eight distinct roles, eight queue entries, and eight paid contact
 * lookups to find the same person. This collapses them to one.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not decide whether "AI Finance" and "AI Neobank" are really the same
 * job. It cannot: two product teams with two managers look exactly like one
 * team advertised twice, from the title alone. Any regex clever enough to feel
 * confident here would just be hiding the guess.
 *
 * So the key is deliberately blunt and the GROUP IS A HYPOTHESIS. The
 * qualifier it grouped away is kept, so a group can be read and argued with,
 * and being wrong costs a correction rather than a silently lost opportunity.
 */

/**
 * Where a qualifier starts.
 *
 * Dash forms are unambiguous. A comma is not — "Product Lead, Growth" is a
 * qualifier but "Product Manager, Payments and Risk Platform" is the job's
 * actual name, so a comma only counts when what follows is short.
 */
const DASH = /\s[-–—|]\s/;
const COMMA = /,\s/;
const MAX_COMMA_QUALIFIER = 25;

/** Below this, the remainder is too thin to be a role name. See finding 1.a. */
const MIN_KEY = 3;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Split a title into what names the role and what merely varies. */
function split(title: string): { core: string; qualifier: string } {
  const t = collapse(title);

  const dash = t.search(DASH);
  if (dash > 0) {
    return { core: t.slice(0, dash), qualifier: collapse(t.slice(dash).replace(/^\s*[-–—|]\s*/, '')) };
  }

  const comma = t.search(COMMA);
  if (comma > 0) {
    const tail = collapse(t.slice(comma + 1));
    if (tail.length <= MAX_COMMA_QUALIFIER) return { core: t.slice(0, comma), qualifier: tail };
  }

  return { core: t, qualifier: '' };
}

/**
 * The part of the title that names the role.
 *
 * Falls back to the whole title when stripping leaves too little: a posting
 * titled only "- AI Finance" would otherwise key to the empty string, and
 * every such posting at a company would collapse into one nameless role.
 */
export function roleCore(title: string): string {
  const { core } = split(title);
  const trimmed = collapse(core);
  return trimmed.length >= MIN_KEY ? trimmed : collapse(title);
}

/** What this posting varies on — "AI Neobank App". Empty when it does not. */
export function qualifierOf(title: string): string {
  return split(title).qualifier;
}

/**
 * A segment safe to put in a role id.
 *
 * The id is `company::unit::roleCore`, so any segment containing `::` would
 * corrupt it — and a company really can be called something like "A::B". v1.0
 * never guarded this on the company either.
 */
export function slugSegment(s: string): string {
  const out = collapse(s).toLowerCase().replace(/:+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'unknown';
}

/**
 * The role's identity, and the primary key of the `roles` table.
 *
 * Three segments, because a role is a job at a business unit, not just at a
 * company. Bjak advertises the same "Technical Product Lead" under BJAK and
 * under KIRA; those are two jobs with two managers, and a two-segment key
 * merged them.
 *
 * The unit comes from the company taxonomy, derived once per company. Passing
 * `'default'` reproduces the two-segment behaviour exactly, which is what a
 * company with one brand should get.
 *
 * `company` is free text from the board, so "Bjak" and "Bjak Sdn Bhd" still
 * split a role in two. Known boundary rather than oversight — no source in
 * this repo gives a stable employer id.
 */
export function roleKey(company: string, unit: string, title: string): string {
  return `${slugSegment(company)}::${slugSegment(unit)}::${roleCore(title).toLowerCase()}`;
}

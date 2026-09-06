/**
 * Which posting represents a role.
 *
 * One job is advertised many times, and exactly one of those listings takes
 * the queue slot. Every other sits in `variant` underneath it. This file is
 * the ONLY place that order is written down.
 *
 * It exists because there used to be two copies. `roles.ts --backfill` elected
 * correctly across every member of a role; `poll.ts` had a weaker copy that
 * only ever saw the survivors of the current pass, and since nothing in
 * `poll.ts` demoted an incumbent, a role gained one representative per pass in
 * which it gained a posting. On 2026-09-06 two roles had two representatives
 * each — two queue slots and two paid contact lookups for the same job.
 *
 * The bug was not the missing merge. The bug was the second copy: two
 * statements of one rule drift, and this pair drifted into a defect nothing
 * could see. So the merge is the small part of the fix and this file is the
 * large one.
 *
 * PURE. No database, no clock, no config — every input is a field on
 * `Candidate`, which is what makes the rule testable without a store.
 */

/**
 * A posting competing for its role's slot.
 *
 * NORMALISED ON PURPOSE, and this is not ceremony. `poll.ts` holds
 * `JobPosting`, whose field is `postedAt`; the store returns `RolePosting`,
 * whose field is `posted_at`. Sorting both with one comparator reads
 * `undefined` on whichever shape it was not written for, every date silently
 * becomes 0, and the election degrades to the id tiebreak without failing.
 *
 * That is the same failure as reading `headline` from a source that returns
 * `summary`: the information was there and nothing read it. Both callers map
 * into this shape explicitly so the mismatch cannot happen quietly.
 */
export interface Candidate {
  id: string;
  postedAt: string | null;
  score: number | null;
  /** An outcome has been recorded against it — a person has been contacted. */
  contacted: boolean;
  /** Its current state. `scored` means it is the incumbent representative. */
  state: string;
}

/**
 * States a posting can be elected from.
 *
 * `skipped` is absent deliberately: Mahi rejected that posting, and grouping
 * has no standing to bring it back. `rejected` and `seen` never carry a
 * role_id in the first place.
 */
const ELECTABLE = new Set(['scored', 'variant']);

const time = (iso: string | null): number => (iso ? Date.parse(iso) : 0);

/**
 * The members of one role, in election order. The first is the representative.
 *
 * Returns an empty array when nothing is electable — a role whose every
 * listing has been skipped has no representative, and that is a real state
 * rather than an error.
 *
 * THE ORDER, and why each term is where it is:
 *
 *   1. CONTACTED FIRST, unconditionally. A posting somebody has been messaged
 *      about is the one the operator has in hand. Demoting it would drop the
 *      role out of the queue while its outcome row hung off a posting nothing
 *      reads. This outranks a better score, because a better listing of a job
 *      you have already started is not worth losing the thread for.
 *
 *   2. FRESHEST, then 3. BEST SCORED. The substance of the choice.
 *
 *   4. THE INCUMBENT, on a tie. Once `poll` can demote — which it could not
 *      before this file existed — two postings that tie on everything above
 *      would swap the slot on every pass, and the queue would reshuffle daily
 *      for no reason a reader could see. A challenger takes the slot only by
 *      being STRICTLY BETTER, never by arriving.
 *
 *   5. LOWEST ID, so the result is total and stable. Without a final total
 *      term the sort is at the mercy of input order, and the input order is
 *      whatever the database happened to return.
 */
export function elect(candidates: Candidate[]): Candidate[] {
  // Dedupe by id before anything else. A posting present in both the pass's
  // survivors and the store's members would otherwise compete with itself, and
  // the comparator would be asked to order a row against a copy of itself.
  const unique = new Map<string, Candidate>();
  for (const c of candidates) {
    if (!ELECTABLE.has(c.state)) continue;
    const existing = unique.get(c.id);
    // Prefer the copy that knows more: contacted and incumbent are facts the
    // store holds and a freshly fetched posting does not.
    if (!existing) unique.set(c.id, c);
    else {
      unique.set(c.id, {
        ...existing,
        contacted: existing.contacted || c.contacted,
        state: existing.state === 'scored' || c.state === 'scored' ? 'scored' : existing.state,
        score: existing.score ?? c.score,
        postedAt: existing.postedAt ?? c.postedAt,
      });
    }
  }

  return [...unique.values()].sort((a, b) => {
    if (a.contacted !== b.contacted) return a.contacted ? -1 : 1;

    const at = time(a.postedAt);
    const bt = time(b.postedAt);
    if (at !== bt) return bt - at;

    const as = a.score ?? 0;
    const bs = b.score ?? 0;
    if (as !== bs) return bs - as;

    const ai = a.state === 'scored';
    const bi = b.state === 'scored';
    if (ai !== bi) return ai ? -1 : 1;

    return a.id < b.id ? -1 : 1;
  });
}

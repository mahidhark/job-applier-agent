/**
 * Does a cited source actually appear in what the tools returned?
 *
 * This is the only defence against an agent inventing something that will be
 * sent to a real person, so it has to be right in both directions. Three
 * failure modes have already shown up in live runs, and every one of them made
 * the checker accuse a model that had done nothing wrong:
 *
 *   1. The transcript was empty (a field-name bug), so nothing could match.
 *      Reported as "the model fabricated". Now distinguished as UNCHECKABLE.
 *
 *   2. Tool output is stored JSON-encoded, so a post containing a newline
 *      appears as a literal \n and a quote as \". A perfectly verbatim citation
 *      fails a naive substring test.
 *
 *   3. Models quote and then annotate: `"...the actual quote..." — Name, date
 *      (note: this post is two years old)`. Requiring the whole field to match
 *      fails on the annotation, which is the honest part.
 *
 * So: pull the quoted span out of the citation, normalise both sides, and ask
 * whether any substantial quoted fragment is present.
 */

export type Verdict = 'grounded' | 'not_found' | 'uncheckable' | 'no_claim';

export interface GroundingResult {
  verdict: Verdict;
  /** The fragment that was actually looked for. */
  checked: string | null;
  reason: string;
}

/** Collapse whitespace, unescape JSON, drop case. Content must still match. */
export function normalise(s: string): string {
  return s
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const MIN_FRAGMENT = 20;

/**
 * Candidate fragments to look for, longest first: anything the model put in
 * quotes, then the whole citation as a fallback for a model that did not quote.
 */
export function candidates(source: string): string[] {
  const out: string[] = [];
  for (const re of [/"([^"]{10,})"/g, /[“]([^”]{10,})[”]/g, /'([^']{20,})'/g]) {
    for (const m of source.matchAll(re)) if (m[1]) out.push(m[1]);
  }
  out.push(source);
  return [...new Set(out)]
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_FRAGMENT)
    .sort((a, b) => b.length - a.length);
}

export function checkGrounding(
  observation: string,
  source: string,
  transcript: string,
): GroundingResult {
  const obs = observation.trim();
  if (!obs || obs.toUpperCase() === 'NONE') {
    return { verdict: 'no_claim', checked: null, reason: 'no observation was claimed' };
  }
  if (!transcript.trim()) {
    return {
      verdict: 'uncheckable', checked: null,
      reason: 'no tool output was captured — this is a harness fault, not a model one',
    };
  }
  const src = source.trim();
  if (!src || src.toUpperCase() === 'NONE' || src.length < MIN_FRAGMENT) {
    return {
      verdict: 'not_found', checked: null,
      reason: `an observation was made with no usable citation (need ${MIN_FRAGMENT}+ chars)`,
    };
  }

  const hay = normalise(transcript);
  for (const c of candidates(src)) {
    if (hay.includes(normalise(c))) {
      return { verdict: 'grounded', checked: c, reason: 'cited text found in tool output' };
    }
  }
  return {
    verdict: 'not_found', checked: candidates(src)[0] ?? src,
    reason: 'no quoted fragment of the citation appears in any tool output',
  };
}

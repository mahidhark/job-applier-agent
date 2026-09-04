/**
 * Is this candidate group one job, or several?
 *
 * The string key cannot answer it, and no key can. On 2026-09-04 it merged
 * Skydreams' "Senior Product Manager - Homedeal" with "- Moving24", which are
 * two brands under one parent and therefore two managers and two jobs. That
 * string is structurally identical to "Technical Product Lead - AI Neobank",
 * which SHOULD merge. Same shape, different meaning, and the title carries
 * nothing that separates them.
 *
 * The answer is in the description — Homedeal is a home-services marketplace,
 * Moving24 is a moving company — and `jobs.raw` has held every description all
 * along. The grouping code just never looked. That is the same failure shape
 * as reading `headline` from a source that returns `summary`: the information
 * was there and nothing read it.
 *
 * So the key becomes a candidate GENERATOR and this module decides.
 */
import { modelForTask, type AiConfig } from '../ai/index.js';
import { correctionsFor } from '../store/db.js';

/** Beyond this many, the prompt stops being worth its context. Finding 1.a. */
const MAX_SHOWN = 12;
/** Enough to tell a moving company from a marketplace; not a whole posting. */
const DESCRIPTION_CHARS = 1200;
/** A group where most descriptions are blank cannot be judged. Finding 1.b. */
const MIN_DESCRIBED = 0.5;

export interface CandidatePosting {
  jobId: string;
  title: string;
  qualifier: string;
  description: string;
}

export interface JudgedGroup {
  jobIds: string[];
  roleTitle: string;
  reasoning: string;
  confident: boolean;
}

export interface Judgement {
  groups: JudgedGroup[];
  /** The model, or `key` when this is the deterministic fallback. */
  decider: string;
  /** True when more postings were present than could be shown. */
  partial: boolean;
  /** What the judge was told about past corrections, for the audit trail. */
  priorCorrections: number;
}

/**
 * JSON Schema, not Zod, because that is what `Model.parse` takes — the
 * provider's own constraint mechanism gets it, rather than a post-hoc parse of
 * free text. On a small model that difference is the whole game: an
 * unconstrained one emits prose wrapped around its JSON.
 */
export const SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['groups'],
  // Every object node needs this explicitly, or Anthropic rejects the request
  // with "For 'object' type, 'additionalProperties' must be explicitly set to
  // false". Measured, not remembered.
  additionalProperties: false,
  properties: {
    groups: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['jobIds', 'roleTitle', 'reasoning', 'confident'],
        properties: {
          jobIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          roleTitle: { type: 'string' },
          reasoning: { type: 'string' },
          confident: { type: 'boolean' },
        },
      },
    },
  },
};

const SYSTEM =
  'You decide whether several job listings are one job advertised repeatedly or ' +
  'genuinely different jobs. You answer only with the requested structure.';

/**
 * Every posting its own role.
 *
 * The fallback, and the answer whenever confidence is absent. NOT a failure
 * mode — see `splitOnUnsure` for why this direction is the safe one.
 */
export function splitAll(postings: CandidatePosting[], decider: string, reason: string): Judgement {
  return {
    decider,
    partial: false,
    priorCorrections: 0,
    groups: postings.map((p) => ({
      jobIds: [p.jobId],
      roleTitle: p.title,
      reasoning: reason,
      confident: false,
    })),
  };
}

/**
 * A partition the model returned may be malformed: a dropped id, a duplicated
 * one, an invented one. Finding 1.c — never trust the shape.
 */
export function partitionCovers(groups: JudgedGroup[], postings: CandidatePosting[]): boolean {
  const want = new Set(postings.map((p) => p.jobId));
  const got: string[] = groups.flatMap((g) => g.jobIds);
  if (got.length !== want.size) return false;
  const seen = new Set<string>();
  for (const id of got) {
    if (!want.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Split any group of more than one that the model was not confident about.
 *
 * THE ERRORS ARE NOT SYMMETRIC, and this is the load-bearing rule of the whole
 * design. Over-splitting costs $0.14 twice and shows up as two queue entries
 * you can see. Over-merging is invisible: a job never seen, a manager never
 * contacted, and no signal ever arrives to tell you. You cannot learn from an
 * opportunity you did not know existed, so the default favours the error you
 * find out about.
 */
export function splitOnUnsure(groups: JudgedGroup[], postings: CandidatePosting[]): JudgedGroup[] {
  const byId = new Map(postings.map((p) => [p.jobId, p]));
  return groups.flatMap((g) => {
    if (g.confident || g.jobIds.length === 1) return [g];
    return g.jobIds.map((id) => ({
      jobIds: [id],
      roleTitle: byId.get(id)?.title ?? g.roleTitle,
      reasoning: `split: ${g.reasoning} (not confident these are one role)`,
      confident: false,
    }));
  });
}

function describedEnough(postings: CandidatePosting[]): boolean {
  const withText = postings.filter((p) => p.description.trim().length > 80).length;
  return withText / postings.length >= MIN_DESCRIBED;
}

export function buildPrompt(
  company: string, postings: CandidatePosting[], corrections: string[],
): string {
  const shown = postings.slice(0, MAX_SHOWN);
  const lines = shown.map((p, i) =>
    `[${i + 1}] jobId: ${p.jobId}\n` +
    `    title: ${p.title}\n` +
    `    varies on: ${p.qualifier || '(nothing)'}\n` +
    `    description: ${p.description.slice(0, DESCRIPTION_CHARS).replace(/\s+/g, ' ').trim()}`,
  ).join('\n\n');

  const learned = corrections.length
    ? `\nWHAT I HAVE BEEN TOLD BEFORE, by the person this is for:\n` +
      corrections.map((c) => `  - ${c}`).join('\n') +
      `\nThese are corrections to earlier groupings. Apply the same reasoning.\n`
    : '';

  return `${company} has posted these listings. They share a job title and differ
only by a trailing qualifier. Decide whether they are ONE job advertised
several times, or SEVERAL different jobs.

The distinction that matters: a qualifier naming a PRODUCT LINE of one team
usually means one job ("AI Finance" and "AI Neobank" at a fintech). A qualifier
naming a separate BRAND, BUSINESS UNIT or SUBSIDIARY usually means different
jobs with different managers, because each brand has its own leadership.

Read the descriptions. They say what the product actually is; the titles do not.
${learned}
${lines}

Return a partition of every jobId above. For each group give a roleTitle, your
reasoning, and whether you are confident those listings are genuinely one job.

Set confident: false whenever you are unsure. Being unsure is a useful answer
here — an unsure group gets split, and a wrong split is cheap and visible while
a wrong merge silently hides a job from someone who would have applied to it.`;
}

/** The correction notes worth showing, oldest last. */
function priorNotes(subjectPrefix: string): string[] {
  return correctionsFor('group', subjectPrefix)
    .map((d) => d.correction_note?.trim())
    .filter((n): n is string => Boolean(n));
}

export async function judgeCandidate(
  company: string,
  _roleId: string,
  postings: CandidatePosting[],
  config: AiConfig,
): Promise<Judgement> {
  if (postings.length < 2) {
    return { ...splitAll(postings, 'key', 'only one listing'), priorCorrections: 0 };
  }
  if (!describedEnough(postings)) {
    return splitAll(postings, 'key',
      'too few descriptions to judge; split rather than guess at a merge');
  }

  const notes = priorNotes(`${company.toLowerCase()}::`);
  const shown = postings.slice(0, MAX_SHOWN);
  const model = modelForTask(config, 'judge');

  const { value } = await model.parse<{ groups: JudgedGroup[] }>(
    SYSTEM, buildPrompt(company, postings, notes), SCHEMA,
  );

  if (!Array.isArray(value?.groups) || !partitionCovers(value.groups, shown)) {
    return splitAll(postings, 'key',
      'the judge returned a partition that did not cover the listings exactly once');
  }

  const groups = splitOnUnsure(value.groups, shown);

  // Anything past the cap keeps the key's answer rather than being dropped.
  const overflow = postings.slice(MAX_SHOWN);
  for (const p of overflow) {
    groups.push({
      jobIds: [p.jobId], roleTitle: p.title, confident: false,
      reasoning: 'beyond the number of listings the judge was shown',
    });
  }

  return {
    groups,
    decider: model.id,
    partial: overflow.length > 0,
    priorCorrections: notes.length,
  };
}

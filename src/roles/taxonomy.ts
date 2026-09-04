/**
 * What brands or business units does this company run?
 *
 * Asked ONCE per company, and that is the whole point. v2.0 asked "are these
 * one job?" per candidate group, so Bjak's taxonomy was derived six
 * independent times from six overlapping slices of evidence — and it landed
 * differently. Four groups contained both brands; two split on the boundary
 * and two did not, one of them contradicting what the same model had concluded
 * confidently minutes earlier.
 *
 * The model was not being erratic. It was being asked six unrelated questions
 * and answering each one locally, which is what it was asked to do. Which
 * brands a company runs is a fact about the company, so it gets derived once
 * and grouping becomes deterministic again.
 *
 * Same failure shape as the rest of this week: reading `headline` per source
 * instead of normalising once, and inferring actor health from repeated
 * emptiness instead of reading the field that said so. A fact that belongs in
 * one place, derived in many.
 */
import { modelForTask, type AiConfig } from '../ai/index.js';
import { correctionsFor } from '../store/db.js';

/** Beyond this the prompt stops being worth its context. Finding 1.a. */
const MAX_QUALIFIERS = 40;
/** Enough boilerplate to name a brand; not a whole posting. */
const EXCERPT = 800;
/** What an empty qualifier is called in the prompt and the assignment. */
export const NO_QUALIFIER = '(no qualifier)';
/** Where an unassignable qualifier goes. Finding 2.c / §3.4. */
export const OWN_UNIT = '__own__';

export interface CompanyUnit {
  name: string;
  description: string;
  /** Text from a description that shows this unit exists. Required, so an
   *  invented unit has to cite something. */
  evidence: string;
}

export interface Taxonomy {
  units: CompanyUnit[];
  /** qualifier -> unit name. */
  assignment: Record<string, string>;
  decider: string;
  /** True when more distinct qualifiers existed than could be shown. */
  partial: boolean;
  attempts: number;
}

export interface QualifierSample {
  qualifier: string;
  exampleTitle: string;
  description: string;
}

export interface TaxonomyPosting {
  title: string;
  qualifier: string;
  description: string;
}

/**
 * One example per DISTINCT qualifier, not one per posting.
 *
 * Bjak has 38 live listings carrying about 8 distinct qualifiers. Showing one
 * excerpt per qualifier is the same evidence at a fifth of the tokens, and it
 * still works at a company with 300 postings where showing all of them would
 * not. Most frequent first, so the cap drops the long tail rather than the
 * signal.
 */
export function sampleByQualifier(
  postings: TaxonomyPosting[], max = MAX_QUALIFIERS,
): { samples: QualifierSample[]; tail: string[] } {
  const byQualifier = new Map<string, TaxonomyPosting[]>();
  for (const p of postings) {
    const key = p.qualifier.trim() || NO_QUALIFIER;
    const bucket = byQualifier.get(key);
    if (bucket) bucket.push(p); else byQualifier.set(key, [p]);
  }

  const ranked = [...byQualifier.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    return a[0] < b[0] ? -1 : 1; // stable, so runs are reproducible
  });

  const samples = ranked.slice(0, max).map(([qualifier, group]) => {
    // The longest description carries the most boilerplate to identify a brand.
    const best = [...group].sort((a, b) => b.description.length - a.description.length)[0]!;
    return {
      qualifier,
      exampleTitle: best.title,
      description: best.description.slice(0, EXCERPT).replace(/\s+/g, ' ').trim(),
    };
  });
  return { samples, tail: ranked.slice(max).map(([qualifier]) => qualifier) };
}

/**
 * A unit name safe to put in a role id.
 *
 * The id is `company::unit::roleCore`, so a unit called "Foo :: Bar" would
 * corrupt it. The display name is stored separately and is what a human ever
 * sees — finding 1.d, which applies to company names too and was never guarded
 * in v1.0.
 */
export function slugifyUnit(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'unit';
}

/**
 * Rebuild a Taxonomy from what the store holds.
 *
 * Read on every poll, so it must be cheap and must never call a model. A
 * company with nothing recorded gets a single unit, which reproduces the
 * pre-taxonomy grouping exactly.
 */
export function taxonomyFromStore(
  units: Array<{ slug: string; name: string; qualifiers: string }>,
): Taxonomy {
  if (!units.length) {
    return {
      units: [{ name: 'default', description: 'no taxonomy recorded', evidence: 'default' }],
      assignment: {}, decider: 'key', partial: false, attempts: 0,
    };
  }
  const assignment: Record<string, string> = {};
  for (const u of units) {
    for (const qual of JSON.parse(u.qualifiers) as string[]) assignment[qual] = u.name;
  }
  return {
    units: units.map((u) => ({ name: u.name, description: '', evidence: 'stored' })),
    assignment, decider: 'store', partial: false, attempts: 0,
  };
}

/** Everything under one roof. The fallback, and the common shape. */
export function singleUnit(
  samples: QualifierSample[], decider: string, reason: string,
): Taxonomy {
  return {
    units: [{ name: 'default', description: 'one company, one unit', evidence: reason }],
    assignment: Object.fromEntries(samples.map((s) => [s.qualifier, 'default'])),
    decider,
    partial: false,
    attempts: 0,
  };
}

/**
 * Is what the model returned usable?
 *
 * Returns a reason to reject, or null. Finding 1.c — never trust the shape.
 */
export function validateTaxonomy(t: {
  units?: CompanyUnit[]; assignment?: Array<{ qualifier: string; unit: string }>;
}, samples: QualifierSample[]): string | null {
  if (!Array.isArray(t.units) || !t.units.length) return 'no units returned';
  if (!Array.isArray(t.assignment)) return 'no assignment returned';

  const names = t.units.map((u) => (u.name ?? '').trim());
  if (names.some((n) => !n)) return 'a unit has no name';
  const folded = names.map((n) => n.toLowerCase());
  if (new Set(folded).size !== folded.length) return 'two units share a name';
  if (t.units.some((u) => !(u.evidence ?? '').trim())) return 'a unit cites no evidence';

  const known = new Set(folded);
  for (const a of t.assignment) {
    if (!known.has((a.unit ?? '').trim().toLowerCase())) {
      return `qualifier "${a.qualifier}" assigned to unknown unit "${a.unit}"`;
    }
  }
  const assigned = new Set(t.assignment.map((a) => a.qualifier));
  const missing = samples.filter((s) => !assigned.has(s.qualifier));
  if (missing.length) return `${missing.length} qualifier(s) left unassigned`;
  return null;
}

/**
 * Which unit a qualifier belongs to.
 *
 * An unknown qualifier gets its OWN unit rather than joining the parent —
 * §3.4, and the same asymmetry as everywhere else. Over-splitting shows up as
 * a duplicate queue entry you can see; merging two brands hides a job you
 * never learn about.
 */
export function unitFor(taxonomy: Taxonomy, qualifier: string): string {
  // A company with one unit and no assignments is the pre-taxonomy world, and
  // must reproduce it exactly: everything under one roof.
  if (taxonomy.units.length === 1 && !Object.keys(taxonomy.assignment).length) {
    return slugifyUnit(taxonomy.units[0]!.name);
  }
  const key = qualifier.trim() || NO_QUALIFIER;
  const name = taxonomy.assignment[key];
  return name ? slugifyUnit(name) : slugifyUnit(key);
}

const SYSTEM =
  'You identify the brands or business units a company runs, from its job postings. ' +
  'You answer only with the requested structure.';

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['units', 'assignment'],
  additionalProperties: false,
  properties: {
    units: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'evidence'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    assignment: {
      type: 'array', minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['qualifier', 'unit'],
        properties: { qualifier: { type: 'string' }, unit: { type: 'string' } },
      },
    },
  },
};

export function buildPrompt(
  company: string, samples: QualifierSample[], corrections: string[],
): string {
  const lines = samples.map((s, i) =>
    `[${i + 1}] qualifier: ${s.qualifier}\n` +
    `    example title: ${s.exampleTitle}\n` +
    `    description: ${s.description}`,
  ).join('\n\n');

  const learned = corrections.length
    ? `\nWHAT I HAVE BEEN TOLD BEFORE about this:\n` +
      corrections.map((c) => `  - ${c}`).join('\n') + '\n'
    : '';

  return `${company} posts job listings whose titles end in a qualifier. Each block
below is one distinct qualifier, with an example title and part of a real
description that carried it.

Work out what BRANDS or BUSINESS UNITS this company runs, then say which unit
each qualifier belongs to.

Most companies run exactly one. Return a single unit when the descriptions all
describe the same business — that is a normal and expected answer, not a
failure to find something.

Look at the boilerplate: the paragraph describing who the company is. Different
brands describe themselves differently, even when the job titles look alike. A
qualifier naming a product line of one business is NOT a separate unit; a
qualifier naming a differently-described business is.

Every unit must cite evidence: text from a description that shows it exists. Do
not propose a unit you cannot quote something for.
${learned}
${lines}

Assign every qualifier listed above to exactly one unit.`;
}

export async function deriveTaxonomy(
  company: string, postings: TaxonomyPosting[], config: AiConfig,
): Promise<Taxonomy> {
  const { samples, tail } = sampleByQualifier(postings);
  if (!samples.length) return singleUnit(samples, 'key', 'no listings');
  if (samples.length === 1) {
    return singleUnit(samples, 'key', 'only one distinct qualifier at this company');
  }

  const notes = correctionsFor('taxonomy', company.toLowerCase())
    .map((d) => d.correction_note?.trim())
    .filter((n): n is string => Boolean(n));

  interface RawTaxonomy {
    units: CompanyUnit[];
    assignment: Array<{ qualifier: string; unit: string }>;
  }

  const model = modelForTask(config, 'judge');
  const prompt = buildPrompt(company, samples, notes);
  let parsed: RawTaxonomy | null = null;
  let attempts = 0;
  let lastError = '';

  // One retry, naming the rejection. The judge's first dry run showed that a
  // single retry recovers a malformed answer at a fraction of the cost of the
  // fallback it avoids.
  for (const retry of [false, true]) {
    attempts++;
    const extra = retry
      ? `\n\nYour previous answer was rejected: ${lastError}. Every qualifier listed ` +
        `must be assigned to a unit you have named, and every unit must cite evidence.`
      : '';
    const { value } = await model.parse<RawTaxonomy>(SYSTEM, prompt + extra, SCHEMA);
    const problem = validateTaxonomy(value ?? {}, samples);
    if (!problem) { parsed = value; break; }
    lastError = problem;
  }

  if (!parsed) {
    return { ...singleUnit(samples, 'key', `taxonomy rejected twice: ${lastError}`), attempts };
  }

  const assignment: Record<string, string> = {};
  for (const a of parsed.assignment) assignment[a.qualifier] = a.unit.trim();
  // The tail beyond the cap keeps whatever an identical qualifier got, and
  // otherwise falls to its own unit rather than being silently absorbed.
  for (const q of tail) assignment[q] ??= q;

  return {
    units: parsed.units,
    assignment,
    decider: model.id,
    partial: tail.length > 0,
    attempts,
  };
}

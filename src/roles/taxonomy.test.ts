/**
 * The judgement is a model call and cannot be unit-tested. The shell can, and
 * the shell is where every failure so far has actually lived.
 *
 * Fixtures use the real Bjak and Skydreams shapes. Twice now an invented one
 * has passed while the real behaviour was broken: a `headline` field that did
 * not exist on the source, and a Skydreams title I made up.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleByQualifier, slugifyUnit, validateTaxonomy, singleUnit, unitFor, buildPrompt,
  NO_QUALIFIER, type TaxonomyPosting, type QualifierSample, type Taxonomy,
} from './taxonomy.js';

const post = (title: string, qualifier: string, description = 'BJAK is a Southeast Asia superapp.'): TaxonomyPosting =>
  ({ title, qualifier, description });

/** Bjak's real shape: two brands, distinguished by an "App" suffix. */
const BJAK: TaxonomyPosting[] = [
  post('Technical Product Lead - AI Neobank', 'AI Neobank'),
  post('Technical Product Lead - AI Investing', 'AI Investing'),
  post('Technical Product Lead - AI Neobank App', 'AI Neobank App', 'KIRA is our consumer app brand.'),
  post('Technical Product Lead - AI Investing App', 'AI Investing App', 'KIRA is our consumer app brand.'),
  post('Technical Product Manager', '', 'BJAK is a Southeast Asia superapp.'),
];

describe('sampling by distinct qualifier, not by posting', () => {
  test('one sample per qualifier, however many postings carry it', () => {
    const many = [...BJAK, post('Product Lead - AI Neobank', 'AI Neobank')];
    const { samples } = sampleByQualifier(many);
    assert.equal(samples.length, 5);
    assert.equal(samples.filter((s) => s.qualifier === 'AI Neobank').length, 1);
  });

  // Real data: one Bjak listing carries no qualifier at all. Finding 1.b.
  test('an empty qualifier is a real key, not a hole', () => {
    const { samples } = sampleByQualifier(BJAK);
    assert.ok(samples.some((s) => s.qualifier === NO_QUALIFIER));
  });

  test('the most common qualifiers survive the cap, and the rest are reported', () => {
    const posts = [
      post('a - Common', 'Common'), post('b - Common', 'Common'), post('c - Common', 'Common'),
      post('d - Rare', 'Rare'),
    ];
    const { samples, tail } = sampleByQualifier(posts, 1);
    assert.deepEqual(samples.map((s) => s.qualifier), ['Common']);
    assert.deepEqual(tail, ['Rare']);
  });

  test('ordering is stable, so two runs on the same store agree', () => {
    const a = sampleByQualifier(BJAK).samples.map((s) => s.qualifier);
    const b = sampleByQualifier([...BJAK].reverse()).samples.map((s) => s.qualifier);
    assert.deepEqual(a, b);
  });

  test('the longest description is sampled, since boilerplate identifies the brand', () => {
    const { samples } = sampleByQualifier([
      post('x - Q', 'Q', 'short'),
      post('y - Q', 'Q', 'KIRA is our consumer app brand, operating across the region.'),
    ]);
    assert.match(samples[0]!.description, /KIRA/);
  });
});

describe('a unit name that is safe in a role id', () => {
  // The id is company::unit::roleCore, so "Foo :: Bar" would corrupt it.
  test('separators cannot leak into the id', () => {
    assert.ok(!slugifyUnit('Foo :: Bar').includes('::'));
    assert.equal(slugifyUnit('KIRA Superapp'), 'kira-superapp');
  });

  test('a name with nothing usable still yields an id segment', () => {
    assert.equal(slugifyUnit('::'), 'unit');
    assert.equal(slugifyUnit(''), 'unit');
  });

  test('the same name always slugs the same way', () => {
    assert.equal(slugifyUnit('BJAK Superapp'), slugifyUnit('bjak  superapp'));
  });
});

describe('never trusting what came back', () => {
  const samples: QualifierSample[] = [
    { qualifier: 'AI Neobank', exampleTitle: 't', description: 'd' },
    { qualifier: 'AI Neobank App', exampleTitle: 't', description: 'd' },
  ];
  const ok = {
    units: [{ name: 'BJAK', description: 'superapp', evidence: 'BJAK is a superapp' },
            { name: 'KIRA', description: 'consumer app', evidence: 'KIRA is our app brand' }],
    assignment: [{ qualifier: 'AI Neobank', unit: 'BJAK' },
                 { qualifier: 'AI Neobank App', unit: 'KIRA' }],
  };

  test('a well-formed taxonomy passes', () => {
    assert.equal(validateTaxonomy(ok, samples), null);
  });

  test('a qualifier left unassigned is rejected', () => {
    assert.match(validateTaxonomy({ ...ok, assignment: ok.assignment.slice(0, 1) }, samples)!,
      /unassigned/);
  });

  test('an assignment to a unit that was never named is rejected', () => {
    assert.match(validateTaxonomy(
      { ...ok, assignment: [...ok.assignment.slice(0, 1), { qualifier: 'AI Neobank App', unit: 'GHOST' }] },
      samples)!, /unknown unit/);
  });

  // Required so an invented unit has to quote something real.
  test('a unit citing no evidence is rejected', () => {
    assert.match(validateTaxonomy(
      { ...ok, units: [{ name: 'BJAK', description: 'x', evidence: '' }, ok.units[1]!] },
      samples)!, /cites no evidence/);
  });

  test('two units sharing a name are rejected', () => {
    assert.match(validateTaxonomy(
      { ...ok, units: [ok.units[0]!, { ...ok.units[1]!, name: 'bjak' }] }, samples)!,
      /share a name/);
  });

  test('an empty or absent unit list is rejected', () => {
    assert.match(validateTaxonomy({ units: [], assignment: [] }, samples)!, /no units/);
    assert.match(validateTaxonomy({}, samples)!, /no units/);
  });
});

describe('assigning a qualifier to a unit', () => {
  const tax: Taxonomy = {
    units: [{ name: 'KIRA', description: '', evidence: 'e' }],
    assignment: { 'AI Neobank App': 'KIRA' },
    decider: 'test', partial: false, attempts: 1,
  };

  test('a known qualifier gets its unit slug', () => {
    assert.equal(unitFor(tax, 'AI Neobank App'), 'kira');
  });

  // The asymmetry again: over-split is visible, a wrong merge hides a job.
  test('an unknown qualifier gets its OWN unit rather than joining the parent', () => {
    assert.equal(unitFor(tax, 'AI Something Else'), 'ai-something-else');
  });

  test('an empty qualifier resolves through the no-qualifier key', () => {
    const withEmpty: Taxonomy = { ...tax, assignment: { [NO_QUALIFIER]: 'BJAK' } };
    assert.equal(unitFor(withEmpty, ''), 'bjak');
    assert.equal(unitFor(withEmpty, '   '), 'bjak');
  });
});

describe('the single-unit case, which must be inert', () => {
  test('every qualifier maps to one unit', () => {
    const { samples } = sampleByQualifier(BJAK);
    const t = singleUnit(samples, 'key', 'only one distinct qualifier');
    assert.equal(t.units.length, 1);
    assert.equal(new Set(samples.map((s) => unitFor(t, s.qualifier))).size, 1);
  });
});

describe('the prompt', () => {
  const flat = (notes: string[] = []) =>
    buildPrompt('Bjak', sampleByQualifier(BJAK).samples, notes).replace(/\s+/g, ' ');

  test('carries the descriptions, which is where the brand is named', () => {
    assert.match(flat(), /KIRA is our consumer app brand/);
    assert.match(flat(), /BJAK is a Southeast Asia superapp/);
  });

  // Without this the model treats one unit as a failure to find something.
  test('says a single unit is a normal answer', () => {
    assert.match(flat(), /Most companies run exactly one/);
    assert.match(flat(), /normal and expected answer/);
  });

  test('names the product-line versus separate-business distinction', () => {
    assert.match(flat(), /product line of one business is NOT a separate unit/);
  });

  test('requires evidence, so an invented unit has to quote something', () => {
    assert.match(flat(), /Do not propose a unit you cannot quote something for/);
  });

  test('prior corrections are put in front of it', () => {
    assert.match(flat(['BJAK and KIRA are different brands']), /TOLD BEFORE/);
    assert.match(flat(['BJAK and KIRA are different brands']), /different brands/);
    assert.ok(!flat().includes('TOLD BEFORE'));
  });
});

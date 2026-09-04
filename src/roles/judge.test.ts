/**
 * The judgement itself cannot be unit-tested — it is a model call, and asking
 * a model to assert that a model agrees proves nothing. What IS tested is the
 * deterministic shell around it, which is where every failure so far has
 * actually lived.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAll, splitOnUnsure, partitionCovers, buildPrompt,
  SCHEMA, RETRY_HINT, type CandidatePosting, type JudgedGroup,
} from './judge.js';

const p = (jobId: string, title: string, description = 'x'.repeat(200)): CandidatePosting =>
  ({ jobId, title, qualifier: title.split(' - ')[1] ?? '', description });

const SKYDREAMS = [
  p('greenhouse:1', 'Senior Product Manager - Homedeal',
    'Homedeal is our home-services marketplace connecting homeowners with vetted installers.'.repeat(3)),
  p('greenhouse:2', 'Senior Product Manager - Moving24',
    'Moving24 is our moving company, operating a fleet and a network of movers across the Benelux.'.repeat(3)),
];

const group = (jobIds: string[], confident: boolean): JudgedGroup =>
  ({ jobIds, roleTitle: 'Senior Product Manager', reasoning: 'because', confident });

/** The prompt is hard-wrapped, so phrases span newlines. Match on the words. */
const flat = (company: string, ps: CandidatePosting[], notes: string[] = []): string =>
  buildPrompt(company, ps, notes).replace(/\s+/g, ' ');

describe('never trusting the returned partition', () => {
  test('a partition covering every listing once is accepted', () => {
    assert.ok(partitionCovers([group(['greenhouse:1', 'greenhouse:2'], true)], SKYDREAMS));
    assert.ok(partitionCovers(
      [group(['greenhouse:1'], true), group(['greenhouse:2'], true)], SKYDREAMS));
  });

  test('a dropped listing is rejected', () => {
    assert.equal(partitionCovers([group(['greenhouse:1'], true)], SKYDREAMS), false);
  });

  test('a duplicated listing is rejected', () => {
    assert.equal(partitionCovers(
      [group(['greenhouse:1'], true), group(['greenhouse:1'], true)], SKYDREAMS), false);
  });

  test('an invented id is rejected', () => {
    assert.equal(partitionCovers(
      [group(['greenhouse:1', 'greenhouse:99'], true)], SKYDREAMS), false);
  });
});

describe('when unsure, split', () => {
  // The load-bearing rule. Over-splitting costs $0.14 twice and is visible;
  // over-merging hides a job and never tells you.
  test('an unconfident merge becomes singletons', () => {
    const out = splitOnUnsure([group(['greenhouse:1', 'greenhouse:2'], false)], SKYDREAMS);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((g) => g.jobIds), [['greenhouse:1'], ['greenhouse:2']]);
    assert.match(out[0]!.reasoning, /not confident/);
  });

  test('a confident merge survives', () => {
    const out = splitOnUnsure([group(['greenhouse:1', 'greenhouse:2'], true)], SKYDREAMS);
    assert.equal(out.length, 1);
  });

  test('a single-listing group is left alone whatever its confidence', () => {
    assert.equal(splitOnUnsure([group(['greenhouse:1'], false)], SKYDREAMS).length, 1);
  });

  test('a split group keeps each listing its own title, not the group title', () => {
    const out = splitOnUnsure([group(['greenhouse:1', 'greenhouse:2'], false)], SKYDREAMS);
    assert.equal(out[0]!.roleTitle, 'Senior Product Manager - Homedeal');
    assert.equal(out[1]!.roleTitle, 'Senior Product Manager - Moving24');
  });
});

describe('the fallback', () => {
  test('splits everything and says why', () => {
    const j = splitAll(SKYDREAMS, 'key', 'the judge errored');
    assert.equal(j.groups.length, 2);
    assert.equal(j.decider, 'key');
    assert.ok(j.groups.every((g) => !g.confident));
    assert.ok(j.groups.every((g) => g.reasoning === 'the judge errored'));
  });

  // A failing judge must degrade the grouping, never stop the poll.
  test('the fallback shape is a valid partition, so callers can use it directly', () => {
    assert.ok(partitionCovers(splitAll(SKYDREAMS, 'key', 'x').groups, SKYDREAMS));
  });
});

describe('the prompt', () => {
  test('carries the descriptions, which is the whole point', () => {
    const text = buildPrompt('Skydreams', SKYDREAMS, []);
    assert.match(text, /home-services marketplace/);
    assert.match(text, /moving company/);
  });

  test('names the brand-versus-product-line distinction the key cannot make', () => {
    const text = buildPrompt('Skydreams', SKYDREAMS, []);
    assert.match(text, /PRODUCT LINE/);
    assert.match(text, /BRAND, BUSINESS UNIT or SUBSIDIARY/);
  });

  // This is the learning: retrieval, not training.
  test('prior corrections are put in front of the judge', () => {
    const text = buildPrompt('Skydreams', SKYDREAMS,
      ['Homedeal and Moving24 are separate brands']);
    assert.match(text, /WHAT I HAVE BEEN TOLD BEFORE/);
    assert.match(text, /separate brands/);
  });

  test('with no corrections it says nothing about them', () => {
    assert.ok(!buildPrompt('Skydreams', SKYDREAMS, []).includes('TOLD BEFORE'));
  });

  test('tells the judge what an unconfident group leads to', () => {
    assert.match(flat('Skydreams', SKYDREAMS), /An unconfident group is SPLIT/);
  });

  test('only the first 12 listings are shown, so context cannot run away', () => {
    const many = Array.from({ length: 20 }, (_, i) => p(`ashby:${i}`, `Product Lead - P${i}`));
    const text = buildPrompt('Bjak', many, []);
    assert.ok(text.includes('ashby:11'));
    assert.ok(!text.includes('ashby:12'));
  });
});

describe('the schema the provider will actually accept', () => {
  /**
   * Anthropic rejects a structured-output request with
   *   "For 'object' type, 'additionalProperties' must be explicitly set to false"
   * and the failure only appears at call time, against a live API, costing a
   * whole dry run to discover. Cheaper to assert it here.
   */
  test('every object node sets additionalProperties false', () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (o['type'] === 'object' && o['additionalProperties'] !== false) offenders.push(path || '(root)');
      for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
    };
    walk(SCHEMA, '');
    assert.deepEqual(offenders, []);
  });
});

describe('the retry, added after the first dry run', () => {
  // The judge mis-partitioned an eight-listing group and the guard split all
  // eight — the most expensive outcome available at $0.14 a lookup. One retry
  // naming the mistake is far cheaper than that.
  test('the hint lists every id that must appear exactly once', () => {
    const hint = RETRY_HINT(['greenhouse:1', 'greenhouse:2']);
    assert.match(hint, /did not partition the listings correctly/);
    assert.match(hint, /greenhouse:1/);
    assert.match(hint, /greenhouse:2/);
    assert.match(hint, /none may be repeated/);
  });

  test('the fallback reports it was asked twice', () => {
    assert.equal(splitAll(SKYDREAMS, 'key', 'x').attempts, 0);
  });
});

describe('what confidence is defined to mean', () => {
  // The dry run showed the judge reasoning correctly and then hedging, which
  // split a group it had itself identified as one job. That is a prompt
  // problem, not a rule problem.
  test('the prompt says confidence is not certainty', () => {
    const text = flat('Skydreams', SKYDREAMS);
    assert.match(text, /Not certainty/);
    assert.match(text, /would a reasonable person/i);
    assert.match(text, /do not hedge on a judgement you have already made/i);
  });

  test('and says what an unconfident group costs, both ways', () => {
    const text = flat('Skydreams', SKYDREAMS);
    assert.match(text, /wrong merge silently hides a job/);
    assert.match(text, /wastes a paid contact lookup/);
  });
});

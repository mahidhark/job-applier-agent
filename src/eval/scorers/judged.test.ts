/**
 * The judge itself is not tested here — that would mean paying a model to
 * assert that a model agrees. What is tested is the part that can silently go
 * wrong: the rubric, which decides what the judge is even asked.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rubricFor, judgeContext } from './judged.js';
import type { EvalCase } from '../cases.js';

const aCase = (over: Partial<EvalCase> = {}): EvalCase => ({
  jobId: 'greenhouse:1', company: 'Skydreams', title: 'Senior Product Manager',
  companyName: 'Skydreams', companyLinkedinUrl: null,
  shape: 'names_nobody',
  acceptable: [{ name: 'Ingmar van Dongen', profileUrl: 'https://linkedin.com/in/ingmarvandongen' }],
  reason: 'runs the Homedeal brand', split: 'tune',
  ...over,
});

describe('the rubric', () => {
  // If the rubric named the answer, the judge would be `right_contact` with a
  // language model bolted on, and a better choice would score as wrong.
  test('never names the contacts on the answer list', () => {
    const text = JSON.stringify(rubricFor(aCase()));
    assert.ok(!text.includes('Ingmar'));
    assert.ok(!text.includes('ingmarvandongen'));
  });

  test('gives the judge the company and the role to judge against', () => {
    const text = JSON.stringify(rubricFor(aCase()));
    assert.match(text, /Skydreams/);
    assert.match(text, /Senior Product Manager/);
  });

  test('a nobody_findable case is graded on committing nobody, not on who was picked', () => {
    const r = rubricFor(aCase({ shape: 'nobody_findable', acceptable: [] }));
    assert.equal(r.length, 1);
    assert.match(r[0]!.description, /no contact could be found/);
  });

  test('the recruiter criterion is only required on the shape that tests for it', () => {
    const relaxed = rubricFor(aCase()).find((x) => x.id === 'not_a_recruiter');
    const strict = rubricFor(aCase({ shape: 'names_recruiter' })).find((x) => x.id === 'not_a_recruiter');
    assert.equal(relaxed?.required, false);
    assert.equal(strict?.required, true);
  });

  test('the judge context carries the rubric and nothing about the model under test', () => {
    const ctx = judgeContext(aCase());
    assert.deepEqual(Object.keys(ctx), ['rubric']);
  });
});

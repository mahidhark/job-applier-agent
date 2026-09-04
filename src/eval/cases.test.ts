import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCases, type EvalCase } from './cases.js';

const base = (over: Partial<EvalCase> = {}): EvalCase => ({
  jobId: 'greenhouse:1', company: 'Acme', title: 'Senior PM',
  companyName: 'Acme', companyLinkedinUrl: 'https://www.linkedin.com/company/acme/',
  shape: 'names_nobody',
  acceptable: [{ name: 'A Person', profileUrl: 'https://www.linkedin.com/in/aperson' }],
  reason: 'owns product', split: 'tune', ...over,
});

/** A set that passes validation must be able to catch the failures that matter. */
const validSet = (): EvalCase[] => [
  base({ jobId: 'a' }), base({ jobId: 'b' }),
  base({ jobId: 'c', shape: 'nobody_findable', acceptable: [], reason: 'company has no product people' }),
  base({ jobId: 'd', shape: 'nobody_findable', acceptable: [], reason: 'sources cannot see anyone' }),
  base({ jobId: 'e', split: 'holdout' }), base({ jobId: 'f', split: 'holdout' }),
];

test('a well-formed set has no problems', () => {
  assert.deepEqual(validateCases(validSet()), []);
});

test('fewer than two nobody_findable cases is refused', () => {
  // Without these, nothing ever tests whether the agent invents a contact —
  // which is the worst thing it can do.
  const cases = validSet().filter((c) => c.jobId !== 'd');
  assert.match(validateCases(cases)[0]!.problem, /nobody_findable/);
});

test('fewer than two holdout cases is refused', () => {
  const cases = validSet().map((c) => ({ ...c, split: 'tune' as const }));
  assert.ok(validateCases(cases).some((p) => /holdout/.test(p.problem)));
});

test('a nobody_findable case that lists a contact contradicts itself', () => {
  const cases = validSet();
  cases[2]!.acceptable = [{ name: 'X', profileUrl: 'https://www.linkedin.com/in/x' }];
  assert.ok(validateCases(cases).some((p) => /nobody_findable but acceptable/.test(p.problem)));
});

test('a findable case with no acceptable contact is unlabelled, not empty', () => {
  const cases = validSet();
  cases[0]!.acceptable = [];
  assert.ok(validateCases(cases).some((p) => /no acceptable contact/.test(p.problem)));
});

test('a profile URL that is not a LinkedIn profile is caught', () => {
  const cases = validSet();
  cases[0]!.acceptable = [{ name: 'X', profileUrl: 'https://example.com/x' }];
  assert.ok(validateCases(cases).some((p) => /not a LinkedIn profile/.test(p.problem)));
});

test('several acceptable contacts are allowed', () => {
  // A Head of Product and a founder at a small company are both defensible;
  // one expected answer would mark a correct agent wrong.
  const cases = validSet();
  cases[0]!.acceptable = [
    { name: 'A', profileUrl: 'https://www.linkedin.com/in/a' },
    { name: 'B', profileUrl: 'https://www.linkedin.com/in/b' },
  ];
  assert.deepEqual(validateCases(cases), []);
});

test('a duplicate job id is caught', () => {
  const cases = validSet();
  cases[1]!.jobId = 'a';
  assert.ok(validateCases(cases).some((p) => /duplicate/.test(p.problem)));
});

test('a case with no reason is caught', () => {
  const cases = validSet();
  cases[0]!.reason = '  ';
  assert.ok(validateCases(cases).some((p) => /no reason/.test(p.problem)));
});

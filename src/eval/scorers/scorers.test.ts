/**
 * The scorers are the only thing that decides whether a change was an
 * improvement, so a wrong scorer is worse than no scorer — it points the next
 * ten sessions at the wrong problem. Every one of these tests corresponds to a
 * mistake already made in this project.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTestRun, createTestMessage, createTrajectoryTestRun } from '@mastra/evals/scorers/utils';
import type { ScorerRunOutputForAgent } from '@mastra/core/evals';
import { answered, rightContact, noFabrication, grounded, trajectory, isUnscoreable } from './index.js';
import { readRun, urlKey } from './commitment.js';
import type { EvalCase } from '../cases.js';

type Invocation = { toolName: string; args: Record<string, any>; result: Record<string, any> | string };

/** One assistant turn per tool call, which is how a real run comes back. */
function output(calls: Invocation[]): ScorerRunOutputForAgent {
  return calls.map((c, i) =>
    createTestMessage({
      content: '',
      role: 'assistant',
      id: `m${i}`,
      toolInvocations: [{
        toolCallId: `call-${i}`,
        toolName: c.toolName,
        args: c.args,
        result: c.result as Record<string, any>,
        state: 'result',
      }],
    }),
  );
}

const PROFILE = 'https://www.linkedin.com/in/ingmarvandongen';

const found = (people: string): Invocation =>
  ({ toolName: 'find_people_at_company', args: { companyUrl: 'x' }, result: people as any });

const commit = (over: Record<string, any> = {}): Invocation => ({
  toolName: 'record_contact',
  args: {
    name: 'Ingmar van Dongen',
    title: 'Brand Captain',
    profileUrl: PROFILE,
    observation: '',
    observationSource: '',
    reasoning: 'closest to the product',
    ...over,
  },
  result: 'Recorded. You are done.' as any,
});

const noContact: Invocation = {
  toolName: 'record_no_contact',
  args: { reason: 'both sources returned nobody' },
  result: 'Recorded that no contact was found.' as any,
};

const aCase = (over: Partial<EvalCase> = {}): EvalCase => ({
  jobId: 'greenhouse:1', company: 'Skydreams', title: 'Senior PM',
  companyName: 'Skydreams', companyLinkedinUrl: 'https://www.linkedin.com/company/skydreams/',
  shape: 'names_nobody',
  acceptable: [{ name: 'Ingmar van Dongen', profileUrl: PROFILE }],
  reason: 'runs the Homedeal brand', split: 'tune',
  ...over,
});

async function score(scorer: any, calls: Invocation[], c: EvalCase = aCase()) {
  const run = createAgentTestRun({ output: output(calls) });
  return scorer.run({ input: run.input, output: run.output, groundTruth: c });
}

describe('reading the run back', () => {
  test('a refused record_contact did not happen', () => {
    const facts = readRun(output([
      found('Ingmar van Dongen'),
      { ...commit({ observation: 'invented', observationSource: 'nowhere at all in here' }),
        result: 'REFUSED: no quoted fragment of the citation appears in any tool output' as any },
    ]));
    assert.equal(facts.commitment.kind, 'none');
  });

  test('a model that is refused and then corrects itself has committed', () => {
    const facts = readRun(output([
      found('Ingmar van Dongen'),
      { ...commit({ observation: 'x', observationSource: 'y' }), result: 'REFUSED: ...' as any },
      commit(),
    ]));
    assert.equal(facts.commitment.kind, 'contact');
    assert.equal(facts.commitment.name, 'Ingmar van Dongen');
  });

  test('the record tools are not evidence', () => {
    const facts = readRun(output([found('someone'), commit()]));
    assert.equal(facts.evidenceCallCount, 1);
    assert.equal(facts.toolCallCount, 2);
    assert.ok(!facts.transcript.includes('Recorded'));
  });

  test('urls compare without scheme, www or trailing slash', () => {
    assert.equal(urlKey('HTTPS://WWW.LinkedIn.com/in/Foo/'), urlKey('https://linkedin.com/in/foo'));
    assert.notEqual(urlKey('https://linkedin.com/in/foo'), urlKey('https://linkedin.com/in/foobar'));
  });
});

describe('answered', () => {
  test('committing a contact is an answer', async () => {
    assert.equal((await score(answered, [found('x'), commit()])).score, 1);
  });

  // The bug this exists to prevent: correct behaviour scored as failure.
  test('committing nobody is an answer, not a failure', async () => {
    const r = await score(answered, [found('nothing'), noContact], aCase({ shape: 'nobody_findable', acceptable: [] }));
    assert.equal(r.score, 1);
  });

  test('running out of steps without committing is not', async () => {
    const r = await score(answered, [found('a'), found('b'), found('c')]);
    assert.equal(r.score, 0);
    assert.match(r.reason, /never committed/);
  });
});

describe('right_contact', () => {
  test('an accepted profile scores 1', async () => {
    assert.equal((await score(rightContact, [found('x'), commit()])).score, 1);
  });

  test('any of several acceptable contacts scores 1', async () => {
    const c = aCase({ acceptable: [
      { name: 'Someone Else', profileUrl: 'https://linkedin.com/in/someone-else' },
      { name: 'Ingmar van Dongen', profileUrl: PROFILE },
    ] });
    assert.equal((await score(rightContact, [found('x'), commit()], c)).score, 1);
  });

  test('a different real person scores 0', async () => {
    const r = await score(rightContact, [found('x'), commit({ name: 'Tiffany S.', profileUrl: 'https://linkedin.com/in/tiffanysoto' })]);
    assert.equal(r.score, 0);
    assert.match(r.reason, /not among/);
  });

  test('on a nobody_findable case, committing nobody is correct', async () => {
    const c = aCase({ shape: 'nobody_findable', acceptable: [] });
    assert.equal((await score(rightContact, [found('nothing'), noContact], c)).score, 1);
  });

  test('on a nobody_findable case, naming someone is wrong', async () => {
    const c = aCase({ shape: 'nobody_findable', acceptable: [] });
    assert.equal((await score(rightContact, [found('x'), commit()], c)).score, 0);
  });
});

describe('no_fabrication', () => {
  test('a person the tools returned is not invented, even when they are the wrong answer', async () => {
    const calls = [found('Ingmar van Dongen — Brand Captain'), commit()];
    assert.equal((await score(noFabrication, calls)).score, 1);
    // The distinction that makes this a separate gate:
    const c = aCase({ acceptable: [{ name: 'Other', profileUrl: 'https://linkedin.com/in/other' }] });
    assert.equal((await score(rightContact, calls, c)).score, 0);
  });

  test('a person appearing in no tool output is invented', async () => {
    const r = await score(noFabrication, [found('nobody by that name here'), commit()]);
    assert.equal(r.score, 0);
    assert.match(r.reason, /NO tool output/);
  });

  test('matching on the profile url is enough when the name is spelled differently', async () => {
    const calls = [found(`profile: ${PROFILE}`), commit({ name: 'I. van Dongen' })];
    assert.equal((await score(noFabrication, calls)).score, 1);
  });

  test('committing nobody cannot be a fabrication', async () => {
    assert.equal((await score(noFabrication, [found('nothing'), noContact])).score, 1);
  });
});

describe('grounded', () => {
  const POST = 'We are hiring a PM for Homedeal. Message me directly, no recruiters involved.';

  test('a citation present in tool output scores 1', async () => {
    const calls = [
      { toolName: 'read_recent_posts', args: {}, result: `[1] 2026-08-02\n${POST}` as any },
      commit({ observation: 'He asks people to message him directly.', observationSource: `"${POST}"` }),
    ];
    assert.equal((await score(grounded, calls)).score, 1);
  });

  test('json-escaped tool output still matches a verbatim quote', async () => {
    const calls = [
      { toolName: 'read_recent_posts', args: {}, result: `[1]\\n${POST.replace(/"/g, '\\"')}` as any },
      commit({ observation: 'He asks people to message him directly.', observationSource: `"${POST}"` }),
    ];
    assert.equal((await score(grounded, calls)).score, 1);
  });

  test('a quote followed by the model annotating it still matches', async () => {
    const calls = [
      { toolName: 'read_recent_posts', args: {}, result: POST as any },
      commit({
        observation: 'He asks people to message him directly.',
        observationSource: `"${POST}" — Ingmar, Aug 2026 (note: this post is two years old)`,
      }),
    ];
    assert.equal((await score(grounded, calls)).score, 1);
  });

  test('a citation in no tool output scores 0', async () => {
    const calls = [
      { toolName: 'read_recent_posts', args: {}, result: 'nothing relevant here at all' as any },
      commit({ observation: 'He built the growth team.', observationSource: '"he built the growth team from scratch"' }),
    ];
    assert.equal((await score(grounded, calls)).score, 0);
  });

  // Claiming nothing is honest. Penalising it teaches the model to invent.
  test('no observation is not a grounding failure', async () => {
    const r = await score(grounded, [found('Ingmar van Dongen'), commit()]);
    assert.equal(r.score, 1);
    assert.match(r.reason, /no observation/);
  });

  test('an observation with no evidence call at all scores 0', async () => {
    const r = await score(grounded, [commit({ observation: 'He runs Homedeal.', observationSource: '"he runs homedeal"' })]);
    assert.equal(r.score, 0);
  });

  // The mistake that cost the most time: a harness fault reported as the model
  // fabricating. It must stop the run, not lower the score.
  test('tool calls that returned nothing throw rather than scoring zero', async () => {
    const calls: Invocation[] = [
      { toolName: 'read_recent_posts', args: {}, result: '' as any },
      commit({ observation: 'He runs Homedeal.', observationSource: '"he runs homedeal every day"' }),
    ];
    await assert.rejects(() => score(grounded, calls), isUnscoreable);
  });
});

describe('trajectory', () => {
  const step = (name: string) => ({ stepType: 'tool_call' as const, name });

  test('a direct, competent run scores well', async () => {
    const run = createTrajectoryTestRun({
      trajectory: { steps: [step('resolve_company'), step('find_people_at_company'), step('record_contact')] },
    });
    const r = await trajectory.run(run);
    assert.ok(r.score > 0.8, `expected a high score, got ${r.score}`);
  });

  // The finding a single number never surfaced: eighteen searches, no answer.
  test('searching over and over without reading anything scores badly', async () => {
    const run = createTrajectoryTestRun({
      trajectory: { steps: Array.from({ length: 18 }, () => step('find_people_at_company')) },
    });
    const r = await trajectory.run(run);
    assert.ok(r.score < 0.5, `expected a low score for a loop, got ${r.score}`);
  });

  test('falling back to the second source is a longer path, not a wrong one', async () => {
    const run = createTrajectoryTestRun({
      trajectory: {
        steps: [step('resolve_company'), step('find_people_at_company'),
                step('find_employees_at_company'), step('read_recent_posts'), step('record_contact')],
      },
    });
    const direct = await trajectory.run(createTrajectoryTestRun({
      trajectory: { steps: [step('resolve_company'), step('find_people_at_company'), step('record_contact')] },
    }));
    const r = await trajectory.run(run);
    assert.ok(r.score >= direct.score * 0.75, `fallback ${r.score} vs direct ${direct.score}`);
  });
});

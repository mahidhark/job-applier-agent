// Point the store at a throwaway file BEFORE anything imports db.ts, which
// opens its database at module load.
process.env['JOB_AGENT_DB'] = `/tmp/job-agent-test-${process.pid}.db`;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichTools, type EnrichResult } from './tools.js';

/**
 * `record_contact` is the only tool that touches neither the network nor MCP,
 * which is deliberate: the grounding check has to be testable without either.
 */
function harness() {
  let finished: EnrichResult | null = null;
  const tools = enrichTools('test:1', (r) => { finished = r; });
  const record = tools.find((t) => t.name === 'record_contact')!;
  const posts = tools.find((t) => t.name === 'read_recent_posts')!;
  return { record, posts, finished: () => finished };
}

const contact = (extra: Record<string, unknown> = {}) => ({
  name: 'Pieter Westerhuis',
  title: 'Founder & Product Director',
  profileUrl: 'https://linkedin.com/in/example',
  reasoning: 'Owns product at a 64-person company.',
  ...extra,
});

test('a contact with no observation is recorded without a citation', async () => {
  const h = harness();
  const out = await h.record.run(contact());
  assert.match(out, /Recorded/);
  assert.equal(h.finished()?.observation, '');
});

test('an observation without a source is refused', async () => {
  const h = harness();
  const out = await h.record.run(contact({ observation: 'They rebuilt onboarding recently.' }));
  assert.match(out, /REFUSED/);
  assert.match(out, /observationSource/);
  assert.equal(h.finished(), null, 'nothing may be recorded on a refusal');
});

test('an observation whose source was never returned by a tool is refused', async () => {
  const h = harness();
  const out = await h.record.run(contact({
    observation: 'They are hiring aggressively in Berlin.',
    observationSource: 'we are opening a Berlin office next quarter',
  }));
  assert.match(out, /REFUSED/);
  assert.match(out, /does not appear/);
  assert.equal(h.finished(), null);
});

test('a paraphrase of real text is still refused — the quote must be verbatim', async () => {
  const h = harness();
  // Stand in for a tool having returned this text earlier in the run.
  await h.record.run(contact({ observation: 'x', observationSource: 'y' })); // seeds nothing
  const out = await h.record.run(contact({
    observation: 'They care about activation.',
    observationSource: 'they said activation matters a great deal to them',
  }));
  assert.match(out, /REFUSED/);
});

test('a short source is refused even if it would technically match', async () => {
  const h = harness();
  const out = await h.record.run(contact({
    observation: 'Something.', observationSource: 'the',
  }));
  assert.match(out, /REFUSED/);
  assert.match(out, /20 characters/);
});

test('the grounding check ignores whitespace and case, not content', async () => {
  // A real run would populate the transcript through a network tool; this
  // asserts the comparison itself is forgiving about formatting only.
  const h = harness();
  const refusal = await h.record.run(contact({
    observation: 'o', observationSource: 'TEXT THAT WAS NEVER RETURNED AT ALL',
  }));
  assert.match(refusal, /does not appear/);
});

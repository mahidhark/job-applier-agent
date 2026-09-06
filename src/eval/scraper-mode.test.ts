/**
 * The eval harness and the agent must ask the sources for the same thing.
 *
 * This test exists because they drifted, and the drift was invisible from
 * every angle that normally catches things.
 *
 * `harvestapi/linkedin-profile-search` has two modes. Short is cheaper and
 * returns an opaque `/in/ACwAAA...` member id where the profile URL belongs.
 * Full costs more and returns a real vanity URL.
 *
 *   record_contact  REFUSES an opaque id, so the agent can only ever commit
 *                   a vanity URL.
 *   right_contact   matches on profileUrl.
 *
 * So a case set built in Short mode grades every model at zero, no matter how
 * right it is — and reports it as the model failing, which is the single
 * mistake this project has paid the most for.
 *
 * PR #4 moved the agent's tools to Full. `prepare-cases.ts` was not touched,
 * because nothing connected the two files. On 2026-09-06 that cost $1.05 and a
 * case set that could not measure anything.
 *
 * READING SOURCE RATHER THAN BEHAVIOUR is deliberate. The alternative is
 * calling a paid actor to find out, which is what made the bug expensive in the
 * first place. A grep is a poor test of behaviour and an excellent test of
 * "these two files still agree".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isResolvableProfileUrl } from '../agent/profile.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const modesIn = (src: string): string[] =>
  [...src.matchAll(/profileScraperMode:\s*'([^']+)'/g)].map((m) => m[1]!);

describe('the eval harness asks for what the agent asks for', () => {
  const agent = modesIn(read('../agent/tools/index.ts'));
  const cases = modesIn(read('./prepare-cases.ts'));

  test('both files declare a scraper mode at all', () => {
    assert.ok(agent.length >= 2, 'the agent should set a mode on both people-sources');
    assert.ok(cases.length >= 2, 'prepare-cases should set a mode on both people-sources');
  });

  test('neither file uses Short — it returns links nobody can open', () => {
    for (const m of [...agent, ...cases]) {
      assert.doesNotMatch(m, /^Short/, `"${m}" returns an opaque member id where a URL belongs`);
    }
  });

  test('prepare-cases uses exactly the modes the agent uses', () => {
    // Not "both use Full" — the enum trap is that the two actors spell it
    // differently ('Full' vs 'Full ($8 per 1k)'), so the set has to match.
    assert.deepEqual(new Set(cases), new Set(agent));
  });
});

describe('a case can only be graded against a URL something can match', () => {
  test('an opaque member id is not acceptable evidence', () => {
    assert.equal(
      isResolvableProfileUrl('https://www.linkedin.com/in/ACwAAANYZ9IBXWEAHvs_XTracmzQ9BGhHamp14k'),
      false,
    );
  });

  test('a vanity URL is', () => {
    assert.equal(isResolvableProfileUrl('https://www.linkedin.com/in/tiffanysoto'), true);
  });
});

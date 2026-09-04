import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGrounding, candidates, normalise } from './grounding.js';

const POST = 'We are looking for a SEA specialist 👀 Check it out or send me a message';
// How tool output actually arrives: JSON-encoded, newlines escaped.
const TRANSCRIPT = `{"items":[{"content":"Big news!\\n\\n${POST}\\n\\n#hiring","postedAt":"2023-10-31"}]}`;

test('no observation means nothing to check', () => {
  assert.equal(checkGrounding('NONE', 'NONE', TRANSCRIPT).verdict, 'no_claim');
  assert.equal(checkGrounding('', '', TRANSCRIPT).verdict, 'no_claim');
});

test('an empty transcript is a harness fault, not a fabrication', () => {
  const r = checkGrounding('They are hiring.', `"${POST}"`, '');
  assert.equal(r.verdict, 'uncheckable');
  assert.match(r.reason, /harness fault/);
});

test('a quote surrounded by the model\'s own annotation still grounds', () => {
  // The exact shape a live Claude run produced: quote, attribution, caveat.
  const cited = `"${POST}" — Ingmar van Dongen, LinkedIn post, 31 Oct 2023 ` +
                `(his most recent post; note it is over two years old)`;
  const r = checkGrounding('He posts openings himself.', cited, TRANSCRIPT);
  assert.equal(r.verdict, 'grounded');
  assert.equal(r.checked, POST);
});

test('JSON escaping in the transcript does not defeat a verbatim quote', () => {
  const r = checkGrounding('x', '"Big news!\n\nWe are looking for a SEA specialist"', TRANSCRIPT);
  assert.equal(r.verdict, 'grounded');
});

test('an invented quote is still caught', () => {
  const r = checkGrounding(
    'They are opening a Berlin office.',
    '"we are opening a Berlin office next quarter" — LinkedIn post',
    TRANSCRIPT,
  );
  assert.equal(r.verdict, 'not_found');
});

test('an observation with no citation is not grounded', () => {
  assert.equal(checkGrounding('They care about activation.', 'NONE', TRANSCRIPT).verdict, 'not_found');
});

test('a citation too short to mean anything is refused', () => {
  assert.equal(checkGrounding('x', 'hiring', TRANSCRIPT).verdict, 'not_found');
});

test('quoted fragments are tried longest first', () => {
  const c = candidates(`"short one here ok" and "a considerably longer quoted fragment than that"`);
  assert.ok(c[0]!.length > c[1]!.length);
});

test('normalise collapses escapes and case but not content', () => {
  assert.equal(normalise('Hello\\n  WORLD'), 'hello world');
  assert.notEqual(normalise('hello world'), normalise('goodbye world'));
});

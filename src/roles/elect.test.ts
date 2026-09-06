/**
 * The election. Pure, so none of this needs a database.
 *
 * `roles.ts --backfill` had this rule and no test at all; extracting it is the
 * first time it can be asserted rather than read.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { elect, type Candidate } from './elect.js';

const c = (over: Partial<Candidate> & { id: string }): Candidate => ({
  postedAt: null, score: null, contacted: false, state: 'variant', ...over,
});

const won = (list: Candidate[]) => elect(list)[0]?.id;

describe('what may be elected', () => {
  test('a skipped posting is never elected, even when it is the best', () => {
    // Mahi rejected it. Grouping has no standing to bring it back.
    const winner = won([
      c({ id: 'a', state: 'skipped', score: 99, postedAt: '2026-09-06' }),
      c({ id: 'b', state: 'variant', score: 10 }),
    ]);
    assert.equal(winner, 'b');
  });

  test('a role whose every listing is skipped elects nobody', () => {
    // A real state, not an error: nothing should throw and no representative
    // should be written.
    assert.deepEqual(elect([c({ id: 'a', state: 'skipped' })]), []);
  });

  test('an empty role elects nobody', () => {
    assert.deepEqual(elect([]), []);
  });

  test('rejected and seen are not electable', () => {
    assert.deepEqual(
      elect([c({ id: 'a', state: 'rejected' }), c({ id: 'b', state: 'seen' })]),
      [],
    );
  });
});

describe('contacted outranks everything', () => {
  test('a contacted posting beats a fresher, better-scored one', () => {
    // Demoting it would drop the role out of the queue while its outcome row
    // hung off a posting nothing reads.
    const winner = won([
      c({ id: 'fresh', postedAt: '2026-09-06', score: 90 }),
      c({ id: 'old', postedAt: '2020-01-01', score: 1, contacted: true }),
    ]);
    assert.equal(winner, 'old');
  });

  test('between two contacted postings the normal order resumes', () => {
    const winner = won([
      c({ id: 'a', postedAt: '2026-01-01', contacted: true }),
      c({ id: 'b', postedAt: '2026-09-06', contacted: true }),
    ]);
    assert.equal(winner, 'b');
  });
});

describe('the substance of the choice', () => {
  test('freshest wins', () => {
    assert.equal(won([
      c({ id: 'old', postedAt: '2026-01-01', score: 99 }),
      c({ id: 'new', postedAt: '2026-09-01', score: 1 }),
    ]), 'new');
  });

  test('score breaks a date tie', () => {
    assert.equal(won([
      c({ id: 'low', postedAt: '2026-09-01', score: 10 }),
      c({ id: 'high', postedAt: '2026-09-01', score: 80 }),
    ]), 'high');
  });

  test('a missing date does not beat a real one', () => {
    // `postedAt: null` maps to 0, which must lose to any real date rather than
    // silently winning because the field was read as undefined.
    assert.equal(won([
      c({ id: 'nodate', postedAt: null, score: 99 }),
      c({ id: 'dated', postedAt: '2020-01-01', score: 1 }),
    ]), 'dated');
  });

  test('a missing score is not better than a low one', () => {
    assert.equal(won([
      c({ id: 'noscore', score: null }),
      c({ id: 'low', score: 0.1 }),
    ]), 'low');
  });
});

describe('incumbency, so the queue does not reshuffle daily', () => {
  test('the incumbent keeps the slot when everything else ties', () => {
    // Without this, two tied postings swap the slot on every pass and Mahi
    // loses his place for no reason he can see.
    const winner = won([
      c({ id: 'aaa-challenger', postedAt: '2026-09-01', score: 50, state: 'variant' }),
      c({ id: 'zzz-incumbent', postedAt: '2026-09-01', score: 50, state: 'scored' }),
    ]);
    assert.equal(winner, 'zzz-incumbent', 'a lower id must not unseat the incumbent on a tie');
  });

  test('a strictly better challenger does take the slot', () => {
    // Incumbency is a tiebreak, not a shield. A genuinely fresher listing wins.
    const winner = won([
      c({ id: 'challenger', postedAt: '2026-09-06', score: 50, state: 'variant' }),
      c({ id: 'incumbent', postedAt: '2026-09-01', score: 50, state: 'scored' }),
    ]);
    assert.equal(winner, 'challenger');
  });

  test('a better score also unseats the incumbent', () => {
    const winner = won([
      c({ id: 'challenger', postedAt: '2026-09-01', score: 80, state: 'variant' }),
      c({ id: 'incumbent', postedAt: '2026-09-01', score: 50, state: 'scored' }),
    ]);
    assert.equal(winner, 'challenger');
  });
});

describe('determinism', () => {
  test('the id tiebreak is total, so input order cannot change the result', () => {
    const members = [c({ id: 'b' }), c({ id: 'a' }), c({ id: 'c' })];
    assert.equal(won(members), 'a');
    assert.equal(won([...members].reverse()), 'a');
  });

  test('the same store twice gives the same order', () => {
    const members = [
      c({ id: 'x', postedAt: '2026-09-01', score: 5 }),
      c({ id: 'y', postedAt: '2026-09-01', score: 5 }),
      c({ id: 'z', postedAt: '2026-09-02', score: 1 }),
    ];
    assert.deepEqual(elect(members).map((m) => m.id), elect([...members].reverse()).map((m) => m.id));
  });
});

describe('a posting cannot compete with itself', () => {
  test('the same id from two sources collapses to one candidate', () => {
    // poll.ts merges the pass's survivors with the store's members, and a
    // posting present in both would otherwise be ordered against a copy of
    // itself.
    const out = elect([
      c({ id: 'same', postedAt: '2026-09-01', score: 50, state: 'variant' }),
      c({ id: 'same', postedAt: '2026-09-01', score: 50, state: 'scored' }),
    ]);
    assert.equal(out.length, 1);
  });

  test('the merged copy keeps the facts only the store knows', () => {
    // A freshly fetched posting knows nothing about outcomes or incumbency.
    // Losing either on the merge would demote work already in hand.
    const out = elect([
      c({ id: 'same', contacted: false, state: 'variant' }),
      c({ id: 'same', contacted: true, state: 'scored' }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.contacted, true);
    assert.equal(out[0]!.state, 'scored');
  });
});

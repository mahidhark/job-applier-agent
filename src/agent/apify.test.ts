/**
 * Reading an Apify run record correctly.
 *
 * Every case here is a real response shape. The blocking-status ones cost a day
 * of work: linkedin-profile-search returned zero rows for every company
 * including Booking.com, and it was diagnosed as an upstream outage. The run
 * record said "free user run limit exceeded" every single time.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ActorBlockedError, __test } from './apify.js';

const { blockingMessage } = __test;

/** Verbatim from a live call, 2026-09-04. */
const QUOTA_EXCEEDED = JSON.stringify({
  runId: '37I9qxRKbB7X1wpqG',
  actorName: 'harvestapi/linkedin-company-employees',
  status: 'SUCCEEDED',
  statusMessage: 'free user run limit exceeded',
  exitCode: 0,
  stats: { runTimeSecs: 4.707 },
  storages: { datasets: { default: { id: 'yJyuGayR77V1wMbns', itemCount: 0 } } },
});

describe('a run that produced nothing and said why', () => {
  test('an account limit is recognised, not read as an empty search', () => {
    assert.equal(blockingMessage(QUOTA_EXCEEDED), 'free user run limit exceeded');
  });

  test('the error says it is an account problem, so nobody retries the query', () => {
    const e = new ActorBlockedError('harvestapi/x', 'free user run limit exceeded');
    assert.match(e.message, /account or quota problem, not an empty search/);
    assert.match(e.message, /free user run limit exceeded/);
  });

  test('other blocking phrasings are caught too', () => {
    for (const msg of [
      'monthly usage limit reached',
      'Insufficient credit to start this run',
      'Payment required',
      'unauthorized: invalid token',
    ]) {
      const rec = JSON.stringify({ status: 'SUCCEEDED', statusMessage: msg,
        storages: { datasets: { default: { itemCount: 0 } } } });
      assert.ok(blockingMessage(rec), `should have flagged: ${msg}`);
    }
  });

  // The distinction that makes this safe to raise on: a company really can
  // have nobody matching, and that must stay a normal answer.
  test('a genuinely empty run with no explanation is not a block', () => {
    const rec = JSON.stringify({ status: 'SUCCEEDED',
      storages: { datasets: { default: { id: 'abc', itemCount: 0 } } } });
    assert.equal(blockingMessage(rec), null);
  });

  test('a run that produced rows is never a block, whatever it said', () => {
    const rec = JSON.stringify({ status: 'SUCCEEDED', statusMessage: 'usage limit approaching',
      storages: { datasets: { default: { id: 'abc', itemCount: 7 } } } });
    assert.equal(blockingMessage(rec), null);
  });

  test('an unrelated status message is not a block', () => {
    const rec = JSON.stringify({ status: 'SUCCEEDED', statusMessage: 'Scraped 0 profiles',
      storages: { datasets: { default: { itemCount: 0 } } } });
    assert.equal(blockingMessage(rec), null);
  });

  test('a non-JSON block is not mistaken for anything', () => {
    assert.equal(blockingMessage('Fetched all 0 items.'), null);
  });
});

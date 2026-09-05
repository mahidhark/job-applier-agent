/**
 * The shipped config must only use values the actor accepts.
 *
 * `past24Hours` was passed straight through and rejected with
 *   "Field input.datePosted must be equal to one of the allowed values"
 * on every call, for the life of the source. Combined with a wrong endpoint,
 * paid discovery had never once succeeded: 3,088 postings in the store, all of
 * them from the two free ATS boards, and zero discovery spend ever recorded.
 *
 * The per-source try/catch turned that total outage into one warning line per
 * pass, which is why it survived so long.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DATE_POSTED } from './linkedin-jobs.js';

const shipped = JSON.parse(readFileSync('config/sources/searches.json', 'utf8')) as {
  maxSpendPerDayUsd?: number;
  searches: Array<{ name: string; datePosted?: string }>;
};

describe('datePosted', () => {
  test('every value in the shipped config maps to a LinkedIn code', () => {
    for (const s of shipped.searches) {
      if (!s.datePosted) continue;
      assert.ok(s.datePosted in DATE_POSTED,
        `search "${s.name}" uses datePosted "${s.datePosted}", which maps to nothing`);
    }
  });

  test('the codes are the ones the actor actually allows', () => {
    // Quoted verbatim from the 400 the actor returned.
    const allowed = new Set(['', 'r2592000', 'r604800', 'r86400']);
    for (const [name, code] of Object.entries(DATE_POSTED)) {
      assert.ok(allowed.has(code), `${name} maps to "${code}", which the actor rejects`);
    }
  });

  test('the readable names cover the windows worth searching', () => {
    assert.deepEqual(Object.keys(DATE_POSTED).sort(),
      ['anyTime', 'past24Hours', 'pastMonth', 'pastWeek']);
  });
});

describe('the discovery budget', () => {
  // Discovery is $0.0004 a result; a contact lookup is $0.14. One shared cap
  // let two lookups starve a seven-cent discovery pass.
  test('discovery has its own daily cap, separate from enrichment', () => {
    assert.equal(typeof shipped.maxSpendPerDayUsd, 'number');
    assert.ok(shipped.maxSpendPerDayUsd! > 0);
  });

  test('and it is big enough for several full passes', () => {
    const perPass = shipped.searches.reduce((n, s) => n + ((s as { limit?: number }).limit ?? 0), 0)
      * 0.0004 + shipped.searches.length * 0.001;
    assert.ok(shipped.maxSpendPerDayUsd! >= perPass * 3,
      `budget $${shipped.maxSpendPerDayUsd} against $${perPass.toFixed(3)} per pass`);
  });
});

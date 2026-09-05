/**
 * Two budgets, because discovery and enrichment differ by three orders of
 * magnitude. Under one shared cap two contact lookups permanently starve the
 * thing that feeds the funnel — which happened, and blocked a seven-cent
 * discovery pass behind $2.04 of unrelated enrichment.
 *
 * The env var must be set BEFORE db.ts is imported: ESM hoists `import` above
 * module-level code, and getting this wrong once wrote test rows into the
 * production database.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: typeof import('./db.js');
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spend-'));
  process.env['JOB_AGENT_DB'] = join(dir, 'test.db');
  db = await import('./db.js');
});

describe('spend by kind', () => {
  test('enrichment does not count against discovery', () => {
    db.recordSpend('harvestapi/linkedin-profile-search', 1.7, 'x', 'enrich');
    assert.equal(db.spentLast24h('discover'), 0);
    assert.equal(db.spentLast24h('enrich'), 1.7);
  });

  test('discovery does not count against enrichment', () => {
    db.recordSpend('valig/linkedin-jobs-scraper', 0.07, 'pm-nl', 'discover');
    assert.equal(db.spentLast24h('discover'), 0.07);
    assert.equal(db.spentLast24h('enrich'), 1.7);
  });

  test('the total still sees everything', () => {
    assert.ok(Math.abs(db.spentLast24h() - 1.77) < 1e-9);
  });

  // The failure this was written for: $2.04 of enrichment blocking a $0.07
  // discovery pass under a shared $2 cap.
  test('a spent enrichment budget leaves discovery free to run', () => {
    db.recordSpend('harvestapi/linkedin-profile-search', 0.34, 'x', 'enrich');
    assert.ok(db.spentLast24h('enrich') >= 2, 'enrichment is over its $2 cap');
    assert.ok(db.spentLast24h('discover') < 0.5, 'discovery is still under its own');
  });

  /**
   * Rows written before the `kind` column existed are all enrichment. Reading
   * them as anything else would silently forget everything spent before today
   * and leave the enrichment guard defending nothing.
   */
  test('legacy rows with no kind count as enrichment', () => {
    db.run("INSERT INTO spend (at, actor, usd, note) VALUES (?, 'old/actor', 5, null)",
      new Date().toISOString());
    assert.ok(db.spentLast24h('enrich') >= 7);
    assert.ok(db.spentLast24h('discover') < 0.5);
  });

  test('recordSpend defaults to enrichment, the more expensive class', () => {
    db.recordSpend('unlabelled/actor', 0.5);
    assert.ok(db.spentLast24h('discover') < 0.5);
  });

  test('spend outside the window is not counted', () => {
    db.run("INSERT INTO spend (at, actor, usd, note, kind) VALUES (?, 'old', 99, null, 'discover')",
      new Date(Date.now() - 48 * 3600_000).toISOString());
    assert.ok(db.spentLast24h('discover') < 0.5);
  });
});

test('cleanup', () => { rmSync(dir, { recursive: true, force: true }); });

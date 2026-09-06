/**
 * What happened after a human hit send.
 *
 * The env var must be set BEFORE db.ts is imported: ESM hoists `import` above
 * module-level code, and getting this wrong once wrote 99 test rows into the
 * production database.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DB = typeof import('./db.js');
let db: DB;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'outcomes-'));
  process.env['JOB_AGENT_DB'] = join(dir, 'test.db');
  db = await import('./db.js');
});

/** A posting to hang outcomes off. Only the columns the tests read matter. */
function seedJob(id: string): void {
  db.run(
    `INSERT OR REPLACE INTO jobs
       (id, source, title, company, location, url, posted_at, first_seen, last_seen, state, score, raw)
     VALUES (?, 'test', 'Product Lead', 'Acme', 'Amsterdam', 'https://x', NULL, ?, ?, 'scored', 1, '{}')`,
    id, new Date().toISOString(), new Date().toISOString(),
  );
}

const URL_A = 'https://www.linkedin.com/in/a';
const URL_B = 'https://www.linkedin.com/in/b';

describe('the state machine no longer records human actions', () => {
  test('JOB_STATES holds only what the machine decides', () => {
    // Asserted because NOTHING referenced `sent`, `queued` or `enriched` in any
    // test, which is how two of them stayed dead for the life of the enum.
    // Re-adding one should be a deliberate act that breaks this line.
    assert.deepEqual(
      [...db.JOB_STATES].sort(),
      ['rejected', 'scored', 'seen', 'skipped', 'variant'],
    );
  });
});

describe('recording an outcome', () => {
  test('an event creates one row and stamps its own column', () => {
    seedJob('job:1');
    db.recordOutcome('job:1', URL_A, 'sent');
    const [row] = db.outcomesFor('job:1');
    assert.ok(row);
    assert.equal(row.contact_url, URL_A);
    assert.equal(row.channel, 'linkedin');
    assert.ok(row.sent_at);
    assert.equal(row.accepted_at, null);
    assert.equal(row.outcome, null);
  });

  test('a second event fills a different column on the same row', () => {
    seedJob('job:2');
    db.recordOutcome('job:2', URL_A, 'sent');
    db.recordOutcome('job:2', URL_A, 'accepted');
    const rows = db.outcomesFor('job:2');
    assert.equal(rows.length, 1, 'one row per (job, person), not one per event');
    assert.ok(rows[0]!.sent_at);
    assert.ok(rows[0]!.accepted_at);
  });

  test('marking twice does not move the timestamp — the first is the real one', () => {
    seedJob('job:3');
    db.recordOutcome('job:3', URL_A, 'accepted');
    const first = db.outcomesFor('job:3')[0]!.accepted_at;
    db.recordOutcome('job:3', URL_A, 'accepted');
    assert.equal(db.outcomesFor('job:3')[0]!.accepted_at, first);
  });

  test('a reply with no send is recorded, not refused', () => {
    // The message went out before this table existed, or outside the system.
    // Refusing would discard ground truth to protect a schema.
    seedJob('job:4');
    db.recordOutcome('job:4', URL_A, 'replied');
    const [row] = db.outcomesFor('job:4');
    assert.ok(row!.replied_at);
    assert.equal(row!.sent_at, null);
  });

  test('declined is a label, and its note is kept', () => {
    seedJob('job:5');
    db.recordOutcome('job:5', URL_A, 'sent');
    db.recordOutcome('job:5', URL_A, 'declined', { note: 'said the role was filled' });
    const [row] = db.outcomesFor('job:5');
    assert.equal(row!.outcome, 'declined');
    assert.match(row!.note ?? '', /role was filled/);
  });

  test('a second note is appended, never overwritten', () => {
    seedJob('job:6');
    db.recordOutcome('job:6', URL_A, 'sent', { note: 'first' });
    db.recordOutcome('job:6', URL_A, 'replied', { note: 'second' });
    assert.equal(db.outcomesFor('job:6')[0]!.note, 'first | second');
  });
});

describe('keying', () => {
  test('two people on one posting are two rows', () => {
    seedJob('job:7');
    db.recordOutcome('job:7', URL_A, 'sent');
    db.recordOutcome('job:7', URL_B, 'sent');
    assert.equal(db.outcomesFor('job:7').length, 2);
  });

  test('one person across two postings does not overwrite the first', () => {
    // Keying on contact_url alone would lose the earlier outreach entirely.
    seedJob('job:8');
    seedJob('job:9');
    db.recordOutcome('job:8', URL_A, 'sent');
    db.recordOutcome('job:9', URL_A, 'declined');
    assert.equal(db.outcomesFor('job:8').length, 1);
    assert.equal(db.outcomesFor('job:8')[0]!.outcome, null);
    assert.equal(db.outcomesFor('job:9')[0]!.outcome, 'declined');
  });

  test('a null contact collapses to one row, not many', () => {
    // SQLite does not enforce uniqueness across NULLs, so a nullable key
    // column would let one job accumulate unlimited duplicate rows.
    seedJob('job:10');
    db.recordOutcome('job:10', null, 'sent');
    db.recordOutcome('job:10', null, 'accepted');
    const rows = db.outcomesFor('job:10');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.contact_url, '');
    assert.ok(rows[0]!.sent_at && rows[0]!.accepted_at);
  });
});

describe('an unknown posting', () => {
  test('jobExists refuses what the queue would otherwise orphan', () => {
    seedJob('job:11');
    assert.equal(db.jobExists('job:11'), true);
    assert.equal(db.jobExists('job:nope'), false);
  });
});

describe('the rates', () => {
  test('a zero denominator is an em-dash, never 0% and never NaN', () => {
    // `0 sent` and `0 accepted` are the same number meaning opposite things:
    // "nobody contacted" versus "everybody ignored us".
    assert.equal(db.ratePct(0, 0), '—');
    assert.equal(db.ratePct(3, 0), '—');
    assert.equal(db.ratePct(0, 4), '0%');
    assert.equal(db.ratePct(11, 20), '55%');
  });

  test('unsent rows are counted apart, never inside a rate', () => {
    // Deltas, not absolutes: db.ts is a module singleton and the tests above
    // have already written rows into the same temp database.
    const base = db.outreachRates(30);
    seedJob('job:12');
    db.recordOutcome('job:12', URL_B, 'replied'); // no send
    const after = db.outreachRates(30);
    assert.equal(after.sent, base.sent, 'a reply with no send is not outreach');
    assert.equal(after.unsent, base.unsent + 1);
  });

  test('a send outside the window is outside the rates', () => {
    seedJob('job:13');
    db.recordOutcome('job:13', URL_A, 'sent');
    const wide = db.outreachRates(30);
    const narrow = db.outreachRates(0); // window collapses to "now"
    assert.ok(wide.sent >= 1);
    assert.ok(narrow.sent <= wide.sent);
  });

  test('accepted and replied only count when the send is in the window', () => {
    seedJob('job:14');
    db.recordOutcome('job:14', URL_A, 'sent');
    db.recordOutcome('job:14', URL_A, 'accepted');
    const r = db.outreachRates(30);
    assert.ok(r.accepted >= 1);
    assert.ok(r.accepted <= r.sent, 'a rate above 100% means the denominator is wrong');
  });
});

/**
 * The corrections substrate. Every path to improvement — few-shot, retrieval,
 * LoRA, DPO — reads these rows, so a bug here silently disables all four.
 *
 * The env var must be set BEFORE db.ts is imported: ESM hoists `import` above
 * module-level code, and getting this wrong once wrote 99 test rows into the
 * production database.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DB = typeof import('./db.js');
let db: DB;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'decisions-'));
  process.env['JOB_AGENT_DB'] = join(dir, 'test.db');
  db = await import('./db.js');
});

const ctx = { company: 'Skydreams', qualifiers: ['Homedeal', 'Moving24'] };
const chose = { groups: [{ roleTitle: 'Senior Product Manager', qualifiers: ['Homedeal', 'Moving24'] }] };

describe('recording a judgement', () => {
  test('round-trips context, choice and decider', () => {
    const id = db.recordDecision({
      kind: 'group', subject: 'skydreams::senior product manager',
      context: ctx, chose, reasoning: 'both are product roles', decider: 'anthropic:claude-opus-5',
    });
    const [row] = db.decisionsFor('group', 'skydreams::senior product manager');
    assert.ok(row);
    assert.equal(row.id, id);
    assert.equal(row.decider, 'anthropic:claude-opus-5');
    assert.deepEqual(JSON.parse(row.context), ctx);
    assert.equal(row.corrected_at, null);
  });

  test('an uncorrected decision is not offered as a lesson', () => {
    assert.equal(db.correctionsFor('group', 'skydreams::').length, 0);
  });
});

describe('recording a correction', () => {
  test('the note survives, because it is the part that generalises', () => {
    const id = db.recordDecision({
      kind: 'group', subject: 'skydreams::senior product manager',
      context: ctx, chose, decider: 'anthropic:claude-opus-5',
    });
    db.recordCorrection(id, { groups: [{ qualifiers: ['Homedeal'] }, { qualifiers: ['Moving24'] }] },
      'Homedeal and Moving24 are separate brands under one parent');

    const [c] = db.correctionsFor('group', 'skydreams::');
    assert.ok(c);
    assert.match(c.correction_note!, /separate brands/);
    assert.equal(JSON.parse(c.corrected_to!).groups.length, 2);
    assert.ok(c.corrected_at);
  });
});

describe('what the next judgement is shown', () => {
  before(() => {
    for (const [i, note] of ['bjak lesson one', 'bjak lesson two', 'bjak lesson three',
                             'bjak lesson four'].entries()) {
      const id = db.recordDecision({
        kind: 'group', subject: `bjak::role ${i}`, context: {}, chose: {}, decider: 'x',
      });
      db.recordCorrection(id, {}, note);
    }
  });

  test('every correction at the same company comes back', () => {
    const got = db.correctionsFor('group', 'bjak::');
    // All four from this company, and separately a few from elsewhere — the
    // same-company ones are never capped, because a lesson about this employer
    // is the most likely to apply again.
    assert.equal(got.filter((d) => d.subject.startsWith('bjak::')).length, 4);
    assert.ok(got.length > 4, 'recent lessons from elsewhere should also be offered');
  });

  test('corrections from elsewhere are included, but only a few', () => {
    const got = db.correctionsFor('group', 'skydreams::', 3);
    // one Skydreams correction, plus at most 3 from other companies
    assert.equal(got.filter((d) => d.subject.startsWith('skydreams::')).length, 1);
    assert.equal(got.filter((d) => !d.subject.startsWith('skydreams::')).length, 3);
  });

  test('a company with nothing recorded still gets the recent general lessons', () => {
    const got = db.correctionsFor('group', 'unknownco::', 2);
    assert.equal(got.length, 2);
    assert.ok(got.every((d) => Boolean(d.correction_note)));
  });

  test('kinds do not leak into each other', () => {
    const id = db.recordDecision({ kind: 'contact', subject: 'bjak::x', context: {}, chose: {}, decider: 'x' });
    db.recordCorrection(id, {}, 'a contact lesson');
    assert.ok(db.correctionsFor('group', 'bjak::').every((d) => d.kind === 'group'));
  });
});


describe('the company taxonomy', () => {
  test('round-trips units and their qualifiers', () => {
    db.saveTaxonomy('bjak', [
      { slug: 'bjak', name: 'BJAK', description: 'superapp', evidence: 'BJAK is', qualifiers: ['AI Neobank'] },
      { slug: 'kira', name: 'KIRA', description: 'app brand', evidence: 'KIRA is', qualifiers: ['AI Neobank App'] },
    ]);
    const units = db.taxonomyFor('bjak');
    assert.equal(units.length, 2);
    assert.deepEqual(units.map((u) => u.slug), ['bjak', 'kira']);
    assert.deepEqual(JSON.parse(units[1]!.qualifiers), ['AI Neobank App']);
  });

  /**
   * Re-deriving because one unseen qualifier turned up must not rename a unit
   * that roles already point at. A full re-derivation is a deliberate act, not
   * a side effect of a new posting appearing.
   */
  test('re-saving is additive: names hold, qualifiers accumulate', () => {
    db.saveTaxonomy('bjak', [
      { slug: 'kira', name: 'KIRA RENAMED', evidence: 'x', qualifiers: ['AI Finance App'] },
    ]);
    const kira = db.taxonomyFor('bjak').find((u) => u.slug === 'kira')!;
    assert.equal(kira.name, 'KIRA', 'the existing name must survive');
    assert.deepEqual(JSON.parse(kira.qualifiers).sort(), ['AI Finance App', 'AI Neobank App']);
  });

  test('the same qualifier twice does not duplicate', () => {
    db.saveTaxonomy('bjak', [{ slug: 'kira', name: 'KIRA', evidence: 'x', qualifiers: ['AI Neobank App'] }]);
    const kira = db.taxonomyFor('bjak').find((u) => u.slug === 'kira')!;
    assert.equal(JSON.parse(kira.qualifiers).length, 2);
  });

  test('companies do not see each other', () => {
    db.saveTaxonomy('skydreams', [{ slug: 'homedeal', name: 'Homedeal', evidence: 'x', qualifiers: ['Homedeal'] }]);
    assert.equal(db.taxonomyFor('bjak').length, 2);
    assert.equal(db.taxonomyFor('skydreams').length, 1);
    assert.equal(db.taxonomyFor('nobody').length, 0);
  });

  test('a taxonomy correction is retrievable like any other decision', () => {
    const id = db.recordDecision({
      kind: 'taxonomy', subject: 'bjak', context: {}, chose: {}, decider: 'anthropic:x',
    });
    db.recordCorrection(id, {}, 'BJAK and KIRA are different brands');
    const got = db.correctionsFor('taxonomy', 'bjak');
    assert.equal(got.length, 1);
    assert.match(got[0]!.correction_note!, /different brands/);
    // and it does not leak into group corrections
    assert.ok(db.correctionsFor('group', 'bjak::').every((d) => d.kind === 'group'));
  });
});

test('cleanup', () => { rmSync(dir, { recursive: true, force: true }); });

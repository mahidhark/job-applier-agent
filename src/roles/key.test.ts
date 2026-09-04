/**
 * Every title here is copied verbatim from the store, not invented. The
 * `headline` bug proved that plausible fixtures pass while reality fails —
 * the field the code read simply did not exist on the real rows.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roleKey, roleCore, qualifierOf } from './key.js';

/** Bjak's ten highest-scoring postings, exactly as stored. */
const BJAK = [
  'Technical Product Lead - AI Finance',
  'Technical Product Lead - AI Finance App',
  'Technical Product Lead - AI Neobank App',
  'Technical Product Lead - AI Investing App',
  'Technical Product Lead - AI Stockbroking App',
  'Technical Product Lead - AI Neobank',
  'Technical Product Lead - AI Investing',
  'Technical Product Lead - AI Stockbroking',
  'Product Lead - AI Stockbroking',
  ' Product Lead - AI Investing App',
];

describe('the ten real Bjak titles', () => {
  test('collapse to two roles, not ten', () => {
    const keys = new Set(BJAK.map((t) => roleKey('Bjak', 'default', t)));
    assert.equal(keys.size, 2, [...keys].join(' | '));
  });

  test('and those two are the two job levels, not an artefact', () => {
    const keys = [...new Set(BJAK.map((t) => roleKey('Bjak', 'default', t)))].sort();
    assert.deepEqual(keys, ['bjak::default::product lead', 'bjak::default::technical product lead']);
  });

  // Real data, not a hypothetical: this row is stored with a leading space.
  test('a leading space does not create a third role', () => {
    assert.equal(roleKey('Bjak', 'default', ' Product Lead - AI Investing App'),
                 roleKey('Bjak', 'default', 'Product Lead - AI Stockbroking'));
  });

  test('the qualifier is kept, so a group can be read and argued with', () => {
    assert.equal(qualifierOf('Technical Product Lead - AI Neobank App'), 'AI Neobank App');
    assert.equal(qualifierOf(' Product Lead - AI Investing App'), 'AI Investing App');
  });
});

describe('what must NOT merge', () => {
  test('two genuinely different roles at one company stay apart', () => {
    assert.notEqual(
      roleKey('Skydreams', 'default', 'Senior Product Manager - Homedeal'),
      roleKey('Skydreams', 'default', 'Finance Operations Specialist'),
    );
  });

  /**
   * THE KNOWN WRONG MERGE, recorded rather than hidden.
   *
   * Skydreams runs several brands. `Homedeal` and `Moving24` are business
   * units, not product variants of one job — the store also holds a rejected
   * "Junior Customer Success Manager (French speaking) - Moving24", which is
   * what a brand name looks like when it is reused across unrelated roles.
   * Two brands means two managers, so these are two jobs.
   *
   * The key merges them, and no key can do better. Structurally they are
   * identical to Bjak's "Technical Product Lead - AI Finance" vs "- AI
   * Neobank", which SHOULD merge. The same shape means two different things at
   * two companies, and the title carries nothing that separates them.
   *
   * This test asserts the wrong behaviour on purpose, so that the limitation
   * is visible in the suite instead of living in a doc nobody re-reads. When
   * splitting exists, this becomes its first case.
   *
   * Found on the very first grouping run — which is the argument for having
   * built the group as a hypothesis with its variants left visible, rather
   * than a dedupe that discards.
   */
  test('KNOWN LIMITATION: two brands under one parent merge, and should not', () => {
    assert.equal(
      roleKey('Skydreams', 'default', 'Senior Product Manager - Homedeal'),
      roleKey('Skydreams', 'default', 'Senior Product Manager - Moving24'),
    );
  });

  test('the same title at two companies is two roles', () => {
    assert.notEqual(roleKey('Bjak', 'default', 'Product Lead'), roleKey('Skydreams', 'default', 'Product Lead'));
  });

  test('seniority is part of the role, not a qualifier', () => {
    assert.notEqual(roleKey('X', 'default', 'Senior Product Manager'), roleKey('X', 'default', 'Product Manager'));
    assert.notEqual(roleKey('X', 'default', 'Technical Product Lead - A'), roleKey('X', 'default', 'Product Lead - A'));
  });
});

describe('separators', () => {
  test('hyphen, en dash, em dash and pipe all split', () => {
    for (const sep of ['-', '–', '—', '|']) {
      assert.equal(roleCore(`Product Manager ${sep} Growth`), 'Product Manager', `separator ${sep}`);
    }
  });

  test('a short comma tail is a qualifier', () => {
    assert.equal(roleCore('Product Lead, Growth'), 'Product Lead');
    assert.equal(qualifierOf('Product Lead, Growth'), 'Growth');
  });

  // The reason a comma is not treated like a dash. Cutting here would rename
  // the job to something it is not.
  test('a long comma tail is part of the job name', () => {
    const t = 'Product Manager, Payments and Risk Platform';
    assert.equal(roleCore(t), t);
    assert.equal(qualifierOf(t), '');
  });

  test('a hyphen inside a word is not a separator', () => {
    assert.equal(roleCore('Full-Stack Product Manager'), 'Full-Stack Product Manager');
    assert.equal(roleCore('Product Manager (Go-To-Market)'), 'Product Manager (Go-To-Market)');
  });
});

describe('degenerate titles', () => {
  // Finding 1.a: stripping can leave nothing, and every such posting at a
  // company would then collapse into one nameless role.
  test('a title that is only a qualifier keeps its whole title', () => {
    assert.equal(roleCore('- AI Finance'), '- AI Finance');
    assert.notEqual(roleKey('Bjak', 'default', '- AI Finance'), roleKey('Bjak', 'default', '- AI Neobank'));
  });

  test('a very short core falls back rather than keying to nearly nothing', () => {
    assert.equal(roleCore('PM - Growth'), 'PM - Growth');
  });

  test('an empty title does not throw', () => {
    assert.equal(roleKey('Bjak', 'default', ''), 'bjak::default::');
    assert.equal(qualifierOf(''), '');
  });

  test('case and inner whitespace do not create separate roles', () => {
    assert.equal(roleKey('BJAK', 'default', 'Product   Lead  -  A'), roleKey('bjak', 'default', 'product lead - B'));
  });
});

describe('the unit segment', () => {
  // Finding 8.c: the single-unit case must be provably inert, or every company
  // without a taxonomy silently regroups.
  test("a single unit reproduces the pre-taxonomy grouping exactly", () => {
    const keys = new Set(BJAK.map((t) => roleKey('Bjak', 'default', t)));
    assert.equal(keys.size, 2);
  });

  // The whole reason for the segment: Bjak runs BJAK and KIRA, and the same
  // job title under each is two jobs with two managers.
  test('the same title under two units is two roles', () => {
    assert.notEqual(
      roleKey('Bjak', 'bjak', 'Technical Product Lead - AI Neobank'),
      roleKey('Bjak', 'kira', 'Technical Product Lead - AI Neobank App'),
    );
  });

  test('different titles under one unit still merge', () => {
    assert.equal(
      roleKey('Bjak', 'kira', 'Technical Product Lead - AI Neobank App'),
      roleKey('Bjak', 'kira', 'Technical Product Lead - AI Finance App'),
    );
  });

  // Finding 1.d — a segment containing "::" would corrupt the id, and a
  // company can genuinely be named that way.
  test('no segment can smuggle a separator into the id', () => {
    assert.equal(roleKey('A::B', 'x', 'Lead').split('::').length, 3);
    assert.equal(roleKey('Bjak', 'A::B', 'Lead').split('::').length, 3);
  });

  test('an empty segment still yields an id of three parts', () => {
    assert.equal(roleKey('', '', 'Lead').split('::').length, 3);
    assert.match(roleKey('', '', 'Lead'), /^unknown::unknown::lead$/);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * db.ts opens its database at module load, so JOB_AGENT_DB must be set before
 * that module is evaluated. Static `import` is hoisted above module-level code,
 * which means a top-of-file assignment runs TOO LATE and the tests silently
 * write to the real database — each run adding another row, so the suite passed
 * once and then failed with steadily climbing counts.
 *
 * Dynamic import after the assignment is the fix. Any future test that touches
 * the store must do the same.
 */
process.env['JOB_AGENT_DB'] = join(mkdtempSync(join(tmpdir(), 'liveness-')), 'agent.db');
const { recordActorCall, actorHealth } = await import('./db.js');

/**
 * The distinction these protect: a source returning zero for ONE company is
 * data; a source returning zero for EVERY company is an outage. On 2026-09-04
 * both models concluded "no people at this company" — correctly, given what
 * they saw, and wrongly, because the actor was down.
 */

test('a source with results is not degraded', () => {
  recordActorCall('healthy/actor', 5);
  recordActorCall('healthy/actor', 3);
  recordActorCall('healthy/actor', 0);
  const h = actorHealth().find((x) => x.actor === 'healthy/actor')!;
  assert.equal(h.degraded, false);
  assert.equal(h.emptyCalls, 1, 'a single empty is ordinary, not an outage');
});

test('three consecutive empties marks a source degraded', () => {
  recordActorCall('down/actor', 0);
  recordActorCall('down/actor', 0);
  recordActorCall('down/actor', 0);
  assert.equal(actorHealth().find((x) => x.actor === 'down/actor')!.degraded, true);
});

test('two empties is not enough — companies legitimately have nobody', () => {
  recordActorCall('quiet/actor', 0);
  recordActorCall('quiet/actor', 0);
  assert.equal(actorHealth().find((x) => x.actor === 'quiet/actor')!.degraded, false);
});

test('a single result clears a degraded verdict', () => {
  recordActorCall('recovers/actor', 0);
  recordActorCall('recovers/actor', 0);
  recordActorCall('recovers/actor', 0);
  assert.equal(actorHealth().find((x) => x.actor === 'recovers/actor')!.degraded, true);
  recordActorCall('recovers/actor', 4);
  assert.equal(actorHealth().find((x) => x.actor === 'recovers/actor')!.degraded, false);
});

test('errored calls do not count as empty ones', () => {
  // A call that threw tells you nothing about whether the source has data.
  recordActorCall('errors/actor', 0, true);
  recordActorCall('errors/actor', 0, true);
  recordActorCall('errors/actor', 0, true);
  assert.equal(actorHealth().find((x) => x.actor === 'errors/actor'), undefined);
});

test('an unknown actor has no health verdict rather than a false one', () => {
  assert.equal(actorHealth().find((x) => x.actor === 'never/called'), undefined);
});

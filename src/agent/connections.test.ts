import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConnections, listToolProfiles } from './connections.js';

/** A throwaway config dir, so tests never depend on the repo's own file. */
function fixture(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'conn-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'connections.json'), JSON.stringify(config));
  return dir;
}

const base = {
  servers: {
    $comment: 'this is documentation, not a server',
    apify: {
      enabled: true, kind: 'http', url: 'https://mcp.example.com/',
      auth: { type: 'bearer', tokenEnv: 'TEST_TOKEN_A' }, toolProfile: 'narrow',
    },
    off: {
      enabled: false, kind: 'http', url: 'https://mcp.example.com/',
      auth: { type: 'none' }, toolProfile: 'all',
    },
  },
  toolProfiles: {
    $comment: 'also documentation',
    narrow: { description: 'named actors', tools: ['a/b', 'c/d'] },
    all: { description: 'server default', tools: [] },
  },
};

test('$-prefixed keys are documentation and are not treated as data', () => {
  const dir = fixture(base);
  const profiles = listToolProfiles(dir);
  assert.deepEqual(Object.keys(profiles).sort(), ['all', 'narrow']);
  const { status } = resolveConnections(undefined, dir);
  assert.deepEqual(status.map((s) => s.name).sort(), ['apify', 'off']);
});

test('a server whose token env var is unset is not ready, and does not throw', () => {
  delete process.env['TEST_TOKEN_A'];
  const { ready, status } = resolveConnections(undefined, fixture(base));
  assert.equal(ready.length, 0);
  const apify = status.find((s) => s.name === 'apify')!;
  assert.equal(apify.ready, false);
  assert.match(apify.reason, /TEST_TOKEN_A is not set/);
});

test('a resolved server carries the token in a header, and the tools in the URL', () => {
  process.env['TEST_TOKEN_A'] = 'secret-value';
  const { ready } = resolveConnections(undefined, fixture(base));
  const apify = ready.find((s) => s.name === 'apify')!;
  assert.equal(apify.headers['Authorization'], 'Bearer secret-value');
  assert.equal(apify.url.searchParams.get('tools'), 'a/b,c/d');
  delete process.env['TEST_TOKEN_A'];
});

test('a disabled server is reported but never connected', () => {
  process.env['TEST_TOKEN_A'] = 'x';
  const { ready, status } = resolveConnections(undefined, fixture(base));
  assert.equal(ready.find((s) => s.name === 'off'), undefined);
  assert.match(status.find((s) => s.name === 'off')!.reason, /disabled/);
  delete process.env['TEST_TOKEN_A'];
});

test('an override profile applies to every server, so a run can be repeated across surfaces', () => {
  process.env['TEST_TOKEN_A'] = 'x';
  const { ready } = resolveConnections('all', fixture(base));
  const apify = ready.find((s) => s.name === 'apify')!;
  assert.equal(apify.toolProfile, 'all');
  assert.equal(apify.url.searchParams.get('tools'), null, 'an empty profile must not pin tools');
  delete process.env['TEST_TOKEN_A'];
});

test('an unknown profile name is reported rather than silently defaulting', () => {
  process.env['TEST_TOKEN_A'] = 'x';
  const { ready, status } = resolveConnections('nonexistent', fixture(base));
  assert.equal(ready.length, 0);
  assert.match(status.find((s) => s.name === 'apify')!.reason, /unknown toolProfile/);
  delete process.env['TEST_TOKEN_A'];
});

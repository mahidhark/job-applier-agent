/**
 * SQLite state. One row per posting we have ever seen.
 *
 * The database is the memory that makes polling idempotent: a posting seen
 * yesterday must not reappear in today's queue, and a posting we decided
 * against must record WHY, so `npm run explain` can answer for it later.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from '../config.js';
import type { JobPosting } from '../sources/types.js';

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    title         TEXT NOT NULL,
    company       TEXT NOT NULL,
    location      TEXT,
    url           TEXT NOT NULL,
    posted_at     TEXT,
    first_seen    TEXT NOT NULL,
    last_seen     TEXT NOT NULL,
    state         TEXT NOT NULL,
    score         REAL,
    raw           TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gates (
    job_id     TEXT NOT NULL,
    gate       TEXT NOT NULL,
    passed     INTEGER NOT NULL,
    detail     TEXT,
    checked_at TEXT NOT NULL,
    PRIMARY KEY (job_id, gate)
  );
  CREATE TABLE IF NOT EXISTS contacts (
    job_id       TEXT NOT NULL,
    name         TEXT NOT NULL,
    title        TEXT,
    profile_url  TEXT,
    source       TEXT NOT NULL,
    context      TEXT,
    found_at     TEXT NOT NULL,
    PRIMARY KEY (job_id, profile_url)
  );
  CREATE TABLE IF NOT EXISTS drafts (
    job_id     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (job_id, kind)
  );
  CREATE TABLE IF NOT EXISTS spend (
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL,
    usd       REAL NOT NULL,
    note      TEXT
  );
  CREATE TABLE IF NOT EXISTS actor_calls (
    at     TEXT NOT NULL,
    actor  TEXT NOT NULL,
    rows   INTEGER NOT NULL,
    errored INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS actor_calls_actor ON actor_calls(actor, at);
  CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
  CREATE INDEX IF NOT EXISTS jobs_seen  ON jobs(first_seen);
`);

/**
 * States a posting moves through. `queued` is terminal for this agent: the
 * send is a human action, so nothing here ever marks a posting `contacted`.
 * A human does that with `npm run queue -- --sent <id>`.
 */
export const JOB_STATES = ['seen', 'rejected', 'scored', 'enriched', 'queued', 'sent', 'skipped'] as const;
export type JobState = (typeof JOB_STATES)[number];

export function upsertJob(job: JobPosting, state: JobState): boolean {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM jobs WHERE id = ?').get(job.id);
  if (existing) {
    db.prepare('UPDATE jobs SET last_seen = ? WHERE id = ?').run(now, job.id);
    return false; // not new
  }
  db.prepare(
    `INSERT INTO jobs (id, source, title, company, location, url, posted_at,
                       first_seen, last_seen, state, score, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(job.id, job.source, job.title, job.company, job.location, job.url,
        job.postedAt, now, now, state, JSON.stringify(job));
  return true; // new
}

export const setState = (id: string, state: JobState) =>
  db.prepare('UPDATE jobs SET state = ? WHERE id = ?').run(state, id);

export const setScore = (id: string, score: number) =>
  db.prepare('UPDATE jobs SET score = ? WHERE id = ?').run(score, id);

export const recordGate = (id: string, gate: string, passed: boolean, detail: string) =>
  db.prepare(
    `INSERT INTO gates (job_id, gate, passed, detail, checked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(job_id, gate) DO UPDATE SET passed = excluded.passed,
       detail = excluded.detail, checked_at = excluded.checked_at`,
  ).run(id, gate, passed ? 1 : 0, detail, new Date().toISOString());

export const recordContact = (
  jobId: string, name: string, title: string | null,
  profileUrl: string | null, source: string, context: string | null,
) =>
  db.prepare(
    `INSERT OR REPLACE INTO contacts (job_id, name, title, profile_url, source, context, found_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobId, name, title, profileUrl, source, context, new Date().toISOString());

export const recordDraft = (jobId: string, kind: string, body: string) =>
  db.prepare(
    `INSERT OR REPLACE INTO drafts (job_id, kind, body, created_at) VALUES (?, ?, ?, ?)`,
  ).run(jobId, kind, body, new Date().toISOString());

export const recordSpend = (actor: string, usd: number, note?: string) =>
  db.prepare('INSERT INTO spend (at, actor, usd, note) VALUES (?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, usd, note ?? null);

/**
 * Every actor call and how many rows it returned.
 *
 * A source that returns zero for ONE company is data. A source that returns
 * zero for EVERY company is an outage, and the two are indistinguishable from
 * inside a single call. On 2026-09-04 linkedin-profile-search returned zero
 * rows for every company including Booking.com, having worked three hours
 * — which was misdiagnosed as an upstream outage and was almost certainly an
 * exhausted Apify quota, now caught directly in apify.ts. This table stays as
 * corroboration, not as the primary signal it was built to be. Three hours
 * earlier — and both models correctly-but-wrongly concluded "no people at this
 * company". Recording the rate is what makes that difference visible.
 */
export const recordActorCall = (actor: string, rows: number, errored = false) =>
  db.prepare('INSERT INTO actor_calls (at, actor, rows, errored) VALUES (?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, rows, errored ? 1 : 0);

export interface ActorHealth {
  actor: string;
  calls: number;
  emptyCalls: number;
  /** True when it has been called several times recently and returned nothing at all. */
  degraded: boolean;
}

/**
 * Health over the trailing window. Degraded means at least three calls and
 * every one empty — one or two empties is ordinary, since plenty of companies
 * genuinely have nobody matching a title filter.
 */
export function actorHealth(hours = 6): ActorHealth[] {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const rows = q<{ actor: string; calls: number; empties: number }>(
    `SELECT actor, COUNT(*) AS calls, SUM(CASE WHEN rows = 0 THEN 1 ELSE 0 END) AS empties
     FROM actor_calls WHERE at >= ? AND errored = 0 GROUP BY actor`,
    since,
  );
  return rows.map((r) => ({
    actor: r.actor,
    calls: r.calls,
    emptyCalls: r.empties,
    degraded: r.calls >= 3 && r.empties === r.calls,
  }));
}

/** Rolling 24h Apify spend, so the enrich budget is enforceable. */
export function spentLast24h(): number {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = db.prepare('SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE at >= ?')
    .get(since) as { total: number };
  return row.total;
}

export const q = <T>(sql: string, ...params: unknown[]): T[] =>
  db.prepare(sql).all(...params) as T[];

export default db;

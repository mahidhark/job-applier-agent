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

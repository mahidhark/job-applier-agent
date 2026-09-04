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

/**
 * Columns added after the table first shipped.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
 * exists, and this repo has no migration runner, so new columns are added
 * here, guarded, and are always nullable — an older build must still read the
 * database.
 */
function addColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.length || cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

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
    raw           TEXT NOT NULL,
    role_id       TEXT
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
    role_id      TEXT,
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
  CREATE TABLE IF NOT EXISTS roles (
    id         TEXT PRIMARY KEY,
    company    TEXT NOT NULL,
    role_key   TEXT NOT NULL,
    title      TEXT NOT NULL,
    first_seen TEXT NOT NULL
  );
  /**
   * Every judgement the system made, and what Mahi said it should have been.
   *
   * The substrate under every way this can improve. Few-shot needs examples,
   * retrieval needs stored decisions, LoRA needs graded pairs, DPO needs
   * chosen-against-rejected — all four are these rows. Nothing was recorded
   * before this table, so no path was open at all.
   *
   * NOT merged with the gates table, though both record why something
   * happened. A gate row is per-posting per-rule, deterministic and never
   * wrong in the way that matters; a decision is one judgement, made by a
   * model, that a human may overrule. Different lifetimes, different readers.
   *
   * Lives in the same out-of-repo database as contacts, and for the same
   * reason: kind is open so contact and draft decisions land here too, and
   * those name real people.
   *
   * correction_note is the valuable column. "Homedeal and Moving24 are
   * separate brands" generalises to every multi-brand parent; the corrected
   * partition generalises to nothing.
   */
  CREATE TABLE IF NOT EXISTS decisions (
    id              TEXT PRIMARY KEY,
    at              TEXT NOT NULL,
    kind            TEXT NOT NULL,
    subject         TEXT NOT NULL,
    context         TEXT NOT NULL,
    chose           TEXT NOT NULL,
    reasoning       TEXT,
    decider         TEXT NOT NULL,
    corrected_at    TEXT,
    corrected_to    TEXT,
    correction_note TEXT
  );
  CREATE INDEX IF NOT EXISTS decisions_subject ON decisions(kind, subject);
  /**
   * What brands or business units a company runs.
   *
   * Derived ONCE per company, because which brands a company runs is a fact
   * about the company. Asking it per candidate group derived Bjak's taxonomy
   * six independent times from six overlapping slices of evidence, and it
   * landed differently: four groups contained both brands, two split on the
   * boundary and two did not.
   *
   * slug goes into the role id, name is what a human reads. They are separate
   * because a brand called "Foo :: Bar" would otherwise corrupt the id, and
   * the same is true of a company name.
   */
  CREATE TABLE IF NOT EXISTS company_units (
    company     TEXT NOT NULL,
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    evidence    TEXT,
    qualifiers  TEXT NOT NULL,
    decided_at  TEXT NOT NULL,
    PRIMARY KEY (company, slug)
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
// Order matters: the tables must exist before a column can be added to them,
// and the column must exist before an index can be built on it. Getting this
// wrong fails on exactly one of the two cases and passes on the other.
addColumn('jobs', 'role_id', 'TEXT');
addColumn('roles', 'unit', 'TEXT');
addColumn('contacts', 'role_id', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS jobs_role ON jobs(role_id)');

export const JOB_STATES = [
  'seen', 'rejected', 'scored', 'enriched', 'queued', 'sent', 'skipped',
  /**
   * Another advertisement of a role we already kept.
   *
   * Deliberately NOT `skipped`. That state already carries two unrelated
   * meanings — "a duplicate the machine dropped" and "a role Mahi does not
   * want" — and grouping would make the first common enough to drown the
   * second, leaving the count in `npm run status` meaningless. A variant is
   * not a rejection: it is the same job, seen again.
   */
  'variant',
] as const;
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
/**
 * A role, and the postings that advertise it.
 *
 * The id IS the role key, so recording the same role twice is a no-op rather
 * than a second row. That matters because the backfill must be safe to run
 * again after it half-finishes.
 */
export interface Role {
  id: string;
  company: string;
  role_key: string;
  title: string;
  first_seen: string;
}

export const upsertRole = (
  id: string, company: string, roleKey: string, title: string, unit = 'default',
): void => {
  db.prepare(
    `INSERT INTO roles (id, company, role_key, title, first_seen, unit)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(id, company, roleKey, title, new Date().toISOString(), unit);
};

export const setRoleId = (jobId: string, roleId: string): void => {
  db.prepare('UPDATE jobs SET role_id = ? WHERE id = ?').run(roleId, jobId);
};

export interface RolePosting {
  id: string; title: string; url: string; state: string;
  score: number | null; posted_at: string | null; location: string | null;
}

/** Every advertisement of one role, best first. */
export const postingsInRole = (roleId: string): RolePosting[] =>
  q<RolePosting>(
    `SELECT id, title, url, state, score, posted_at, location FROM jobs
     WHERE role_id = ? ORDER BY score DESC, id ASC`, roleId,
  );

export const roleOf = (jobId: string): Role | null =>
  q<Role>(
    `SELECT r.* FROM roles r JOIN jobs j ON j.role_id = r.id WHERE j.id = ?`, jobId,
  )[0] ?? null;

export type DecisionKind = 'group' | 'contact' | 'screen' | 'draft' | 'taxonomy';

export interface Decision {
  id: string;
  at: string;
  kind: DecisionKind;
  /** The thing judged: a role id, a job id. */
  subject: string;
  context: string;
  chose: string;
  reasoning: string | null;
  /** The model that decided, or `key` when it fell back to the deterministic rule. */
  decider: string;
  corrected_at: string | null;
  corrected_to: string | null;
  correction_note: string | null;
}

export function recordDecision(d: {
  kind: DecisionKind; subject: string; context: unknown; chose: unknown;
  reasoning?: string; decider: string;
}): string {
  const id = `${d.kind}:${d.subject}:${Date.now().toString(36)}`;
  db.prepare(
    `INSERT INTO decisions (id, at, kind, subject, context, chose, reasoning, decider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, new Date().toISOString(), d.kind, d.subject,
        JSON.stringify(d.context), JSON.stringify(d.chose), d.reasoning ?? null, d.decider);
  return id;
}

/**
 * Record that a decision was wrong, and why.
 *
 * The note is required by the caller, not by the schema — a correction with no
 * reason teaches nothing, and this table exists to teach.
 */
export function recordCorrection(id: string, correctedTo: unknown, note: string): void {
  db.prepare(
    'UPDATE decisions SET corrected_at = ?, corrected_to = ?, correction_note = ? WHERE id = ?',
  ).run(new Date().toISOString(), JSON.stringify(correctedTo), note, id);
}

/**
 * Corrections to put in front of the next judgement.
 *
 * Same subject prefix first — a role id is `company::role`, so a prefix match
 * is "everything I have been corrected on at this company" — then the most
 * recent others. This is the learning: retrieval, not training, working today
 * on a hosted model with no GPU.
 */
export function correctionsFor(
  kind: DecisionKind, subjectPrefix: string, recent = 3,
): Decision[] {
  const sameSubject = q<Decision>(
    `SELECT * FROM decisions WHERE kind = ? AND corrected_at IS NOT NULL AND subject LIKE ?
     ORDER BY corrected_at DESC`, kind, `${subjectPrefix}%`,
  );
  const seen = new Set(sameSubject.map((d) => d.id));
  const others = q<Decision>(
    `SELECT * FROM decisions WHERE kind = ? AND corrected_at IS NOT NULL
     ORDER BY corrected_at DESC LIMIT ?`, kind, recent + sameSubject.length,
  ).filter((d) => !seen.has(d.id)).slice(0, recent);
  return [...sameSubject, ...others];
}

export const decisionsFor = (kind: DecisionKind, subject: string): Decision[] =>
  q<Decision>(
    'SELECT * FROM decisions WHERE kind = ? AND subject = ? ORDER BY at DESC', kind, subject,
  );

export interface StoredUnit {
  company: string;
  slug: string;
  name: string;
  description: string | null;
  evidence: string | null;
  /** Qualifiers assigned to this unit, as stored JSON. */
  qualifiers: string;
  decided_at: string;
}

export const taxonomyFor = (company: string): StoredUnit[] =>
  q<StoredUnit>('SELECT * FROM company_units WHERE company = ? ORDER BY slug', company);

/**
 * Write a taxonomy.
 *
 * ADDITIVE ONLY. A unit already recorded keeps its name and gains any new
 * qualifiers; nothing is renamed or removed. Re-deriving because one unseen
 * qualifier turned up must not silently rename units that roles already point
 * at — a full re-derivation is a deliberate act, not a side effect.
 */
export function saveTaxonomy(company: string, units: Array<{
  slug: string; name: string; description?: string; evidence?: string; qualifiers: string[];
}>): void {
  const existing = new Map(taxonomyFor(company).map((u) => [u.slug, u]));
  const now = new Date().toISOString();
  const write = db.prepare(
    `INSERT INTO company_units (company, slug, name, description, evidence, qualifiers, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company, slug) DO UPDATE SET qualifiers = excluded.qualifiers`,
  );
  db.transaction(() => {
    for (const u of units) {
      const prev = existing.get(u.slug);
      const merged = prev
        ? [...new Set([...(JSON.parse(prev.qualifiers) as string[]), ...u.qualifiers])]
        : u.qualifiers;
      write.run(company, u.slug, prev?.name ?? u.name, prev?.description ?? u.description ?? null,
                prev?.evidence ?? u.evidence ?? null, JSON.stringify(merged), prev?.decided_at ?? now);
    }
  })();
}

export function spentLast24h(): number {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = db.prepare('SELECT COALESCE(SUM(usd), 0) AS total FROM spend WHERE at >= ?')
    .get(since) as { total: number };
  return row.total;
}

/** For UPDATE / DELETE / INSERT. `q` uses .all(), which throws on those. */
export const run = (sql: string, ...params: unknown[]): void => {
  db.prepare(sql).run(...params);
};

export const q = <T>(sql: string, ...params: unknown[]): T[] =>
  db.prepare(sql).all(...params) as T[];

export default db;

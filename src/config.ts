/** Paths and environment. Nothing personal lives inside this repo. */
import { join } from 'node:path';
import { homedir } from 'node:os';

/** SQLite state. Outside the repo by default; `data/` is gitignored anyway. */
export const DB_PATH = process.env.JOB_AGENT_DB ?? join(homedir(), '.job-applier-agent', 'agent.db');

/**
 * Evidence corpus — the same tagged chunks the Upwork agent drafts from.
 * Personal data, so it lives outside the repo and each operator writes their own.
 */
export const CORPUS_DIR =
  process.env.JOB_AGENT_CORPUS ?? join(homedir(), 'upwork-profile', 'corpus');

export const CONFIG_DIR = process.env.JOB_AGENT_CONFIG_DIR ?? 'config';

/** Apify REST token. Required only when a paid source is enabled. */
export const APIFY_TOKEN = process.env.APIFY_TOKEN ?? '';

export const DRAFT_MODEL = process.env.JOB_AGENT_MODEL ?? 'claude-opus-5';

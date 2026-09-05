/**
 * Configuration, split by concern.
 *
 *   config/default.json          thresholds, weights, drafting, queue
 *   config/sources/ats.json      free official job-board APIs
 *   config/sources/searches.json paid Apify discovery
 *
 * Split because the two source files grow without bound — a company list and a
 * search list are data, while default.json is a rubric. Keeping them apart
 * means adding a company is not a diff against your scoring weights.
 *
 * Validation throws rather than running with a missing section, because a
 * silently-absent threshold is a gate that never fires.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';
import type { BoardConfig } from './sources/types.js';
import { DATE_POSTED } from './sources/apify/linkedin-jobs.js';
import type { AiConfig } from './ai/index.js';

export interface ScreenConfig {
  operatorCountry: string;
  /** Cities and regions that count as the home country. Boards rarely add the
   *  country to a city name, so this is how "Utrecht" is recognised as local. */
  homeLocalities: string[];
  acceptRemoteIn: string[];
  maxAgeDays: number;
  minSalary: number;
  salaryCurrency: string;
  titleMustMatch: string[];
  titleMustNotMatch: string[];
  skills: string[];
  minSkillMatches: number;
}

export interface ScoreConfig {
  weights: Record<string, number>;
  freshnessFloorDays: number;
  companySizeSweetSpot: { min: number; max: number };
}

export interface EnrichConfig {
  targetFunctionIds: string[];
  targetSeniorityIds: string[];
  maxProfilesPerCompany: number;
  recentPostsPerProfile: number;
  onlyRecentlyActive: boolean;
  maxSpendPerDayUsd: number;
}

export interface SearchProfile {
  name: string;
  keywords: string;
  location: string;
  datePosted?: string;
  limit: number;
  under10Applicants?: boolean;
}

export interface AgentConfig {
  pollIntervalMinutes: number;
  screen: ScreenConfig;
  score: ScoreConfig;
  enrich: EnrichConfig;
  draft: { connectionNoteMaxChars: number; coverLetterMaxChars: number; model: string };
  ai: AiConfig;
  queue: { maxPerDay: number };
  boards: BoardConfig[];
  searches: {
    enabled: boolean;
    /** Discovery's own daily cap, separate from `enrich.maxSpendPerDayUsd`. */
    maxSpendPerDayUsd: number;
    discoveryActor: string;
    enrichActor: string;
    searches: SearchProfile[];
  };
}

function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) throw new Error(`missing ${what} at ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new Error(`${what} at ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

export function loadConfig(dir = CONFIG_DIR): AgentConfig {
  const base = readJson<Partial<AgentConfig>>(join(dir, 'default.json'), 'default config');
  const ats = readJson<{ boards?: BoardConfig[] }>(join(dir, 'sources', 'ats.json'), 'ats sources');
  const searches = readJson<AgentConfig['searches']>(join(dir, 'sources', 'searches.json'), 'search sources');

  // Fail at load, not per-pass. An unrecognised value here was passed straight
  // to the actor, which rejected every call — and the per-source try/catch
  // turned that into one warning line, so discovery was dead for the life of
  // the source without anybody noticing.
  for (const s of searches.searches ?? []) {
    if (s.datePosted && !(s.datePosted in DATE_POSTED)) {
      throw new Error(
        `search "${s.name}" has datePosted "${s.datePosted}"; ` +
        `expected one of ${Object.keys(DATE_POSTED).join(', ')}`,
      );
    }
  }

  for (const section of ['screen', 'score', 'enrich', 'draft', 'ai', 'queue'] as const) {
    if (!base[section]) throw new Error(`config/default.json has no "${section}" section`);
  }
  if (!(base.pollIntervalMinutes && base.pollIntervalMinutes >= 15)) {
    throw new Error(`pollIntervalMinutes must be at least 15, got ${base.pollIntervalMinutes}`);
  }
  const boards = ats.boards ?? [];
  const seen = new Set<string>();
  for (const b of boards) {
    const key = `${b.ats}:${b.slug}`;
    if (seen.has(key)) throw new Error(`duplicate board ${key} in config/sources/ats.json`);
    seen.add(key);
  }

  return {
    pollIntervalMinutes: base.pollIntervalMinutes,
    screen: base.screen as ScreenConfig,
    score: base.score as ScoreConfig,
    enrich: base.enrich as EnrichConfig,
    draft: base.draft as AgentConfig['draft'],
    ai: base.ai as AiConfig,
    queue: base.queue as AgentConfig['queue'],
    boards,
    // A missing discovery budget must not read as "unlimited". loadConfig
    // throws rather than running with a missing section for the same reason.
    searches: { ...searches, maxSpendPerDayUsd: searches.maxSpendPerDayUsd ?? 0 },
  };
}

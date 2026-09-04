/**
 * Assembles every configured source.
 *
 * Free boards first and always; the paid LinkedIn discovery only when it is
 * enabled and a token exists. `paid` is on the interface so the orchestrator
 * can put cost behind the gates rather than in front of them.
 */
import type { AgentConfig } from '../config-file.js';
import { APIFY_TOKEN } from '../config.js';
import { buildAtsSources } from './ats/index.js';
import { linkedinSource } from './apify/linkedin-jobs.js';
import type { Source } from './types.js';

export function buildSources(config: AgentConfig): Source[] {
  const sources: Source[] = buildAtsSources(config.boards);

  if (config.searches.enabled) {
    if (!APIFY_TOKEN) {
      console.warn('  ! searches enabled but APIFY_TOKEN is unset — skipping paid discovery');
    } else {
      sources.push(linkedinSource(config));
    }
  }
  return sources;
}

export * from './types.js';

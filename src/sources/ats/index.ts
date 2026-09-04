import type { BoardConfig, Source } from '../types.js';
import { ashbySource } from './ashby.js';
import { greenhouseSource } from './greenhouse.js';
import { leverSource } from './lever.js';

/** Every free board adapter, keyed by the `ats` value in config/sources/ats.json. */
const ADAPTERS: Record<string, (company: string, slug: string) => Source> = {
  ashby: ashbySource,
  greenhouse: greenhouseSource,
  lever: leverSource,
};

export function buildAtsSources(boards: BoardConfig[]): Source[] {
  return boards.map((b) => {
    const make = ADAPTERS[b.ats];
    if (!make) {
      throw new Error(
        `unknown ats "${b.ats}" for ${b.company} — supported: ${Object.keys(ADAPTERS).join(', ')}`,
      );
    }
    return make(b.company, b.slug);
  });
}

export const SUPPORTED_ATS = Object.keys(ADAPTERS);

/**
 * Provider selection, from config.
 *
 * The provider is chosen per TASK, not globally. That is deliberate: the three
 * operations have very different difficulty profiles, and the likely
 * production answer is a mix — a 3B model doing extraction in seconds while
 * the letter, where instruction-following is the whole product, stays on
 * Claude. A single global switch would force an all-or-nothing choice the
 * evidence does not support.
 */
import type { Model } from './types.js';
import { anthropicModel } from './anthropic.js';
import { ollamaModel } from './ollama.js';

export type ProviderName = 'anthropic' | 'ollama';
export type TaskName = 'extract' | 'compose' | 'tools' | 'judge';

export interface AiConfig {
  /** Fallback when a task names no provider of its own. */
  provider: ProviderName;
  /** Per-task override: { compose: "anthropic", extract: "ollama" }. */
  tasks?: Partial<Record<TaskName, ProviderName>>;
  anthropic: { model: string; effort?: 'low' | 'medium' | 'high' };
  ollama: { baseUrl: string; model: string; timeoutMs: number };
}

export function buildModel(config: AiConfig, provider?: ProviderName): Model {
  const name = provider ?? config.provider;
  switch (name) {
    case 'anthropic':
      return anthropicModel(config.anthropic);
    case 'ollama':
      return ollamaModel(config.ollama);
    default:
      throw new Error(`unknown ai provider "${name}"`);
  }
}

export function modelForTask(config: AiConfig, task: TaskName): Model {
  return buildModel(config, config.tasks?.[task] ?? config.provider);
}

export * from './types.js';

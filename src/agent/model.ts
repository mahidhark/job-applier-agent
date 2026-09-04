/**
 * Model selection for the Mastra agent.
 *
 * Both providers go through the Vercel AI SDK so Mastra can drive either
 * without knowing which is which — that is the whole point of the experiment:
 * the same goal, the same tools, the same orchestrator, one variable changed.
 *
 * The local path talks to Ollama, which serves an OpenAI-compatible surface
 * with native tool calling. On CPU it is slow — measured 24s for a 19-token
 * structured response on a 3B Q4 model with no GPU — so a goal-directed loop
 * of six or eight steps is minutes, not seconds. That is expected and the run
 * records latency per step rather than treating it as a fault.
 */
import { anthropic } from '@ai-sdk/anthropic';
import { createOllama } from 'ollama-ai-provider-v2';
import type { AiConfig, ProviderName } from '../ai/index.js';

export function agentModel(config: AiConfig, provider?: ProviderName) {
  const name = provider ?? config.tasks?.tools ?? config.provider;

  if (name === 'ollama') {
    const ollama = createOllama({ baseURL: `${config.ollama.baseUrl}/api` });
    return ollama(config.ollama.model);
  }
  return anthropic(config.anthropic.model);
}

export function modelLabel(config: AiConfig, provider?: ProviderName): string {
  const name = provider ?? config.tasks?.tools ?? config.provider;
  return name === 'ollama' ? `ollama:${config.ollama.model}` : `anthropic:${config.anthropic.model}`;
}

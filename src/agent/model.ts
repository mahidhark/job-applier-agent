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
import { createCerebras } from '@ai-sdk/cerebras';
import type { AiConfig, ProviderName } from '../ai/index.js';

/**
 * Reasoning-class models emit `reasoning_content`, which breaks Mastra's
 * multi-turn message replay on Cerebras and Groq. `reasoning_format: hidden`
 * suppresses it — but a model that is not reasoning-class rejects the
 * parameter outright with a 400, so it must be sent conditionally.
 *
 * The pattern came from whatsscale-ai Sprint 2 Day 5c, which listed Qwen 3 and
 * gpt-oss. Measured against Cerebras 2026-09-04, that is now wrong for Qwen:
 *
 *   gemma-4-31b    no param   OK
 *   qwen-3.8-27b   no param   OK    — WITH the param: 400 "does not support
 *                                     'hidden' reasoning format"
 *   gpt-oss-120b   param      OK
 *
 * So Qwen 3.8 has moved out of the reasoning class on this provider while
 * gpt-oss has not. Verify with data/probe-cerebras.ts before adding a model —
 * inheriting this list from a note is exactly how it went wrong.
 */
const REASONING_MODEL = /gpt-oss/i;

export function agentModel(config: AiConfig, provider?: ProviderName) {
  const name = provider ?? config.tasks?.tools ?? config.provider;

  if (name === 'cerebras') {
    return createCerebras({})(config.cerebras.model);
  }

  if (name === 'ollama') {
    const ollama = createOllama({ baseURL: `${config.ollama.baseUrl}/api` });
    return ollama(config.ollama.model);
  }
  return anthropic(config.anthropic.model);
}

export function modelLabel(config: AiConfig, provider?: ProviderName): string {
  const name = provider ?? config.tasks?.tools ?? config.provider;
  if (name === 'cerebras') return `cerebras:${config.cerebras.model}`;
  return name === 'ollama' ? `ollama:${config.ollama.model}` : `anthropic:${config.anthropic.model}`;
}

/**
 * Per-call provider options, applied at generate time rather than model
 * construction because the v3 provider takes no settings argument.
 *
 * Empty for everything except reasoning-class models on Cerebras, where
 * suppressing reasoning_content is what keeps multi-turn tool replay working.
 */
export function agentProviderOptions(
  config: AiConfig,
  provider?: ProviderName,
): Record<string, Record<string, unknown>> {
  const name = provider ?? config.tasks?.tools ?? config.provider;
  if (name === 'cerebras' && REASONING_MODEL.test(config.cerebras.model)) {
    return { cerebras: { reasoning_format: 'hidden' } };
  }
  return {};
}

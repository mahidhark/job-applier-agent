/**
 * Cerebras, through its OpenAI-compatible chat-completions API.
 *
 * Written against the raw endpoint rather than an SDK because the Model
 * interface needs precise control of the tool-call round trip, and because the
 * one provider-specific parameter that matters — reasoning_format — is not
 * exposed uniformly by wrappers.
 *
 * reasoning_format=hidden suppresses reasoning_content, which otherwise breaks
 * multi-turn tool replay. Measured 2026-09-04: gpt-oss-120b accepts it,
 * qwen-3.8-27b returns 400 "does not support 'hidden' reasoning format", and
 * gemma-4-31b needs nothing. Verify with data/probe-cerebras.ts before adding
 * a model; the list changes and inheriting it from a note has already misfired
 * once.
 */
import type { CompleteOptions, Model, ToolCall, ToolSpec, Turn } from './types.js';
import { ModelError } from './types.js';

const ENDPOINT = 'https://api.cerebras.ai/v1/chat/completions';
const REASONING_MODEL = /gpt-oss/i;

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: unknown;
  message?: string;
}

export interface CerebrasOptions {
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export function cerebrasModel(opts: CerebrasOptions): Model {
  const { model, timeoutMs = 300_000 } = opts;
  const apiKey = opts.apiKey ?? process.env['CEREBRAS_API_KEY'] ?? '';

  async function chat(body: Record<string, unknown>): Promise<{ res: ChatResponse; ms: number }> {
    if (!apiKey) throw new ModelError('CEREBRAS_API_KEY is not set', model);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          ...(REASONING_MODEL.test(model) ? { reasoning_format: 'hidden' } : {}),
          ...body,
        }),
        signal: controller.signal,
      });
      const json = (await r.json()) as ChatResponse;
      if (!r.ok) {
        throw new ModelError(`cerebras HTTP ${r.status}: ${json.message ?? JSON.stringify(json).slice(0, 200)}`, model);
      }
      return { res: json, ms: Date.now() - started };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ModelError(`cerebras timed out after ${timeoutMs}ms`, model, { cause: err });
      }
      throw err instanceof ModelError ? err : new ModelError(String(err), model, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  const usage = (r: ChatResponse, ms: number) => ({
    inputTokens: r.usage?.prompt_tokens ?? null,
    outputTokens: r.usage?.completion_tokens ?? null,
    latencyMs: ms,
  });

  return {
    id: `cerebras:${model}`,

    async complete(system, user, o: CompleteOptions = {}) {
      const { res, ms } = await chat({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
        ...(o.temperature != null ? { temperature: o.temperature } : {}),
      });
      const text = res.choices?.[0]?.message?.content ?? '';
      return { value: text.trim(), usage: usage(res, ms), raw: text };
    },

    async parse<T>(system: string, user: string, schema: Record<string, unknown>) {
      const { res, ms } = await chat({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema } },
        temperature: 0,
      });
      const raw = res.choices?.[0]?.message?.content ?? '';
      try {
        return { value: JSON.parse(raw) as T, usage: usage(res, ms), raw };
      } catch (err) {
        throw new ModelError(`schema-constrained output was not valid JSON: ${raw.slice(0, 200)}`, model, { cause: err });
      }
    },

    async step(system: string, turns: Turn[], tools: ToolSpec[]) {
      const messages: Array<Record<string, unknown>> = [{ role: 'system', content: system }];
      for (const t of turns) {
        if (t.role === 'user') messages.push({ role: 'user', content: t.content });
        else if (t.role === 'assistant') {
          messages.push({
            role: 'assistant',
            content: t.content || null,
            ...(t.toolCalls.length
              ? {
                  tool_calls: t.toolCalls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                  })),
                }
              : {}),
          });
        } else {
          messages.push({ role: 'tool', tool_call_id: t.callId, content: t.content });
        }
      }

      const { res, ms } = await chat({
        messages,
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: 'auto',
        temperature: 0,
      });

      const msg = res.choices?.[0]?.message;
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c, i) => ({
        id: c.id ?? `cb-${i}`,
        name: c.function?.name ?? '',
        arguments: (() => {
          try { return JSON.parse(c.function?.arguments ?? '{}') as Record<string, unknown>; }
          catch { return {}; }
        })(),
      }));

      const text = msg?.content ?? '';
      return { value: { text: text.trim(), toolCalls }, usage: usage(res, ms), raw: text };
    },
  };
}

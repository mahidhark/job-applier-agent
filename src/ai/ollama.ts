/**
 * Local small model through Ollama's chat API.
 *
 * Ollama supports both mechanisms the comparison needs natively: `format` for
 * JSON-Schema-constrained output and `tools` for function calling. Neither is
 * emulated by prompting, so a failure here is the model failing, not the
 * harness.
 *
 * On CPU this is slow — measured 24s for a 19-token structured response on a
 * 3B Q4 model with no GPU. Timeouts are therefore generous by default and the
 * eval records latency as a first-class result rather than an inconvenience.
 */
import type {
  CompleteOptions, Model, ToolCall, ToolSpec, Turn,
} from './types.js';
import { ModelError } from './types.js';

interface OllamaResponse {
  message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export function ollamaModel(opts: OllamaOptions): Model {
  const { baseUrl, model, timeoutMs } = opts;

  async function chat(body: Record<string, unknown>): Promise<{ res: OllamaResponse; ms: number }> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, ...body }),
        signal: controller.signal,
      });
      if (!r.ok) throw new ModelError(`ollama HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`, model);
      return { res: (await r.json()) as OllamaResponse, ms: Date.now() - started };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ModelError(`ollama timed out after ${timeoutMs}ms`, model, { cause: err });
      }
      throw err instanceof ModelError ? err : new ModelError(String(err), model, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  const usage = (r: OllamaResponse, ms: number) => ({
    inputTokens: r.prompt_eval_count ?? null,
    outputTokens: r.eval_count ?? null,
    latencyMs: ms,
  });

  return {
    id: `ollama:${model}`,

    async complete(system, user, o: CompleteOptions = {}) {
      const { res, ms } = await chat({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        options: {
          ...(o.maxTokens ? { num_predict: o.maxTokens } : {}),
          ...(o.temperature != null ? { temperature: o.temperature } : {}),
        },
      });
      const text = res.message?.content ?? '';
      return { value: text.trim(), usage: usage(res, ms), raw: text };
    },

    async parse<T>(system: string, user: string, schema: Record<string, unknown>) {
      const { res, ms } = await chat({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        format: schema,
        options: { temperature: 0 },
      });
      const raw = res.message?.content ?? '';
      try {
        return { value: JSON.parse(raw) as T, usage: usage(res, ms), raw };
      } catch (err) {
        // Constrained decoding should make this impossible. When it happens it
        // is a real finding about the model, so surface it rather than retry.
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
            content: t.content,
            ...(t.toolCalls.length
              ? {
                  tool_calls: t.toolCalls.map((c) => ({
                    function: { name: c.name, arguments: c.arguments },
                  })),
                }
              : {}),
          });
        } else {
          // Ollama has no tool-call ids, so the name is the only linkage.
          messages.push({ role: 'tool', content: t.content, name: t.name });
        }
      }

      const { res, ms } = await chat({
        messages,
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        options: { temperature: 0 },
      });

      const toolCalls: ToolCall[] = (res.message?.tool_calls ?? []).map((c, i) => ({
        id: `ollama-${i}`,
        name: c.function?.name ?? '',
        arguments: (typeof c.function?.arguments === 'string'
          ? JSON.parse(c.function.arguments)
          : c.function?.arguments ?? {}) as Record<string, unknown>,
      }));

      const text = res.message?.content ?? '';
      return { value: { text: text.trim(), toolCalls }, usage: usage(res, ms), raw: text };
    },
  };
}

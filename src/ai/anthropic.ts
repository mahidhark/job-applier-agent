/**
 * Claude, through the official SDK. The baseline the SLM is measured against.
 *
 * Uses the provider's own constraint mechanisms so the comparison is fair:
 * `output_config.format` for schemas and native `tools` for function calling,
 * never JSON.parse over free prose.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  CompleteOptions, Model, ToolCall, ToolSpec, Turn,
} from './types.js';
import { ModelError } from './types.js';

export interface AnthropicOptions {
  model: string;
  /** Effort applies to the whole provider here; per-call tuning is a later concern. */
  effort?: 'low' | 'medium' | 'high';
}

export function anthropicModel(opts: AnthropicOptions, client = new Anthropic()): Model {
  const { model, effort = 'medium' } = opts;

  const usage = (u: { input_tokens?: number; output_tokens?: number } | undefined, ms: number) => ({
    inputTokens: u?.input_tokens ?? null,
    outputTokens: u?.output_tokens ?? null,
    latencyMs: ms,
  });

  const textOf = (content: Anthropic.ContentBlock[]) =>
    content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');

  return {
    id: `anthropic:${model}`,

    async complete(system, user, o: CompleteOptions = {}) {
      const started = Date.now();
      const res = await client.messages.create({
        model,
        max_tokens: o.maxTokens ?? 4000,
        // Identical across every call of a kind, so it caches.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        output_config: { effort },
        messages: [{ role: 'user', content: user }],
      });
      const text = textOf(res.content);
      return { value: text.trim(), usage: usage(res.usage, Date.now() - started), raw: text };
    },

    async parse<T>(system: string, user: string, schema: Record<string, unknown>) {
      const started = Date.now();
      const res = await client.messages.create({
        model,
        max_tokens: 4000,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        output_config: { format: { type: 'json_schema', schema }, effort: 'low' },
        messages: [{ role: 'user', content: user }],
      });
      const raw = textOf(res.content);
      try {
        return { value: JSON.parse(raw) as T, usage: usage(res.usage, Date.now() - started), raw };
      } catch (err) {
        throw new ModelError(`structured output was not valid JSON: ${raw.slice(0, 200)}`, model, { cause: err });
      }
    },

    async step(system: string, turns: Turn[], tools: ToolSpec[]) {
      const started = Date.now();
      const messages: Anthropic.MessageParam[] = [];

      for (const t of turns) {
        if (t.role === 'user') {
          messages.push({ role: 'user', content: t.content });
        } else if (t.role === 'assistant') {
          const blocks: Anthropic.ContentBlockParam[] = [];
          if (t.content) blocks.push({ type: 'text', text: t.content });
          for (const c of t.toolCalls) {
            blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
          }
          messages.push({ role: 'assistant', content: blocks });
        } else {
          // Anthropic requires the result to echo the originating tool_use id,
          // and requires tool results to arrive in a user turn.
          messages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: t.callId, content: t.content }],
          });
        }
      }

      const res = await client.messages.create({
        model,
        max_tokens: 4000,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool.InputSchema,
        })),
        messages,
      });

      const toolCalls: ToolCall[] = res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, arguments: b.input as Record<string, unknown> }));

      const text = textOf(res.content);
      return {
        value: { text: text.trim(), toolCalls },
        usage: usage(res.usage, Date.now() - started),
        raw: text,
      };
    },
  };
}

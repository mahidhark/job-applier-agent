/**
 * The model boundary.
 *
 * Everything the pipeline asks of an LLM goes through this interface, so the
 * provider is a config value rather than an import. Three operations, chosen
 * because they are the three shapes of work the pipeline actually has:
 *
 *   parse      structured extraction against a schema  (machine-facing)
 *   complete   prose a human will read                 (human-facing)
 *   callTools  pick a tool and its arguments           (agentic, not yet used)
 *
 * They are listed in ascending order of how hard they are for a small model,
 * and the eval scores them separately for exactly that reason: "can an SLM
 * replace Claude here" has different answers per operation, and a single
 * verdict would hide that.
 */
export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface ModelResult<T> {
  value: T;
  usage: ModelUsage;
  /** Raw text before parsing. Kept so a schema failure is debuggable. */
  raw: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /**
   * Provider-assigned id. Anthropic supplies one and requires it echoed back
   * on the result; Ollama supplies none, so the loop synthesises a positional
   * id. Never assume it is meaningful across providers.
   */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * One turn of a tool-use conversation.
 *
 * This is the only place the pipeline keeps conversational state, and it lives
 * for the duration of a single enrichment. Nothing persists between jobs.
 */
export type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; content: string };

export interface CompleteOptions {
  /** Soft target; providers differ in whether they can honour it. */
  maxTokens?: number;
  temperature?: number;
}

export interface Model {
  /** Stable id for reporting, e.g. "anthropic:claude-opus-5", "ollama:qwen2.5:3b". */
  readonly id: string;

  /** Prose for a human. */
  complete(system: string, user: string, opts?: CompleteOptions): Promise<ModelResult<string>>;

  /**
   * Structured output constrained by a JSON Schema.
   *
   * Implementations must use the provider's native constraint mechanism —
   * Anthropic's output_config format, Ollama's `format` — and never
   * post-hoc JSON.parse of free text. The difference is the whole point of
   * the comparison: an unconstrained small model emits prose around its JSON.
   */
  parse<T>(system: string, user: string, schema: Record<string, unknown>): Promise<ModelResult<T>>;

  /**
   * One step of a tool-use conversation.
   *
   * Takes the whole turn history rather than a single prompt, because the loop
   * has to feed tool results back. Returns the assistant's text and any tool
   * calls it wants made; an empty `toolCalls` means it is done.
   */
  step(system: string, turns: Turn[], tools: ToolSpec[]): Promise<ModelResult<{ text: string; toolCalls: ToolCall[] }>>;
}

export class ModelError extends Error {
  readonly provider: string;

  constructor(message: string, provider: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelError';
    this.provider = provider;
  }
}

/**
 * A tool-use loop. Sixty lines, deliberately.
 *
 * This is the only agentic surface in the system, and it exists because
 * "find who to talk to about this role" is a goal with real branching: check
 * the job poster, decide whether they are the hiring manager or a recruiter,
 * search the company if absent, read what they have written lately. Every
 * branch hardcoded is a judgement pretended into a rule.
 *
 * Everything else in the pipeline stays deterministic code, because it runs
 * over thousands of postings and has to be explainable.
 *
 * The loop is provider-agnostic on purpose: the same code runs against Claude
 * and against a 3B local model, so the eval measures the models rather than
 * two different harnesses.
 */
import type { Model, ToolCall, ToolSpec, Turn } from '../ai/types.js';

export interface ToolImpl extends ToolSpec {
  /** Estimated USD per invocation, charged against the run budget before the call. */
  costUsd: number;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface AgentBudget {
  /** Hard ceiling on model round-trips. Prevents a confused model looping forever. */
  maxSteps: number;
  /** Hard ceiling on tool spend for this run, in USD. */
  maxSpendUsd: number;
}

export interface AgentTrace {
  step: number;
  text: string;
  calls: Array<{ name: string; arguments: Record<string, unknown>; ok: boolean; result: string }>;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AgentRun {
  /** The assistant's final text once it stopped calling tools. */
  answer: string;
  trace: AgentTrace[];
  spentUsd: number;
  steps: number;
  stopReason: 'done' | 'max_steps' | 'budget' | 'error';
  error?: string;
}

export async function runAgent(
  model: Model,
  system: string,
  task: string,
  tools: ToolImpl[],
  budget: AgentBudget,
): Promise<AgentRun> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs: ToolSpec[] = tools.map(({ name, description, parameters }) => ({
    name, description, parameters,
  }));

  const turns: Turn[] = [{ role: 'user', content: task }];
  const trace: AgentTrace[] = [];
  let spentUsd = 0;

  for (let step = 1; step <= budget.maxSteps; step++) {
    let result;
    try {
      result = await model.step(system, turns, specs);
    } catch (err) {
      return { answer: '', trace, spentUsd, steps: step - 1, stopReason: 'error',
               error: (err as Error).message };
    }

    const { text, toolCalls } = result.value;

    // No tool calls means the model considers itself finished.
    if (toolCalls.length === 0) {
      trace.push({ step, text, calls: [], latencyMs: result.usage.latencyMs,
                   inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
      return { answer: text, trace, spentUsd, steps: step, stopReason: 'done' };
    }

    turns.push({ role: 'assistant', content: text, toolCalls });

    const calls: AgentTrace['calls'] = [];
    for (const call of toolCalls) {
      const tool = byName.get(call.name);

      if (!tool) {
        // A hallucinated tool name is a real signal about the model, so it is
        // reported back rather than silently dropped — and it is exactly the
        // failure the small-model comparison is looking for.
        const msg = `no such tool "${call.name}". Available: ${[...byName.keys()].join(', ')}`;
        calls.push({ name: call.name, arguments: call.arguments, ok: false, result: msg });
        turns.push({ role: 'tool', callId: call.id, name: call.name, content: msg });
        continue;
      }

      if (spentUsd + tool.costUsd > budget.maxSpendUsd) {
        const msg = `budget exhausted: this run has spent $${spentUsd.toFixed(3)} of $${budget.maxSpendUsd}`;
        calls.push({ name: call.name, arguments: call.arguments, ok: false, result: msg });
        trace.push({ step, text, calls, latencyMs: result.usage.latencyMs,
                     inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
        return { answer: text, trace, spentUsd, steps: step, stopReason: 'budget' };
      }

      spentUsd += tool.costUsd;
      let out: string;
      let ok = true;
      try {
        out = await tool.run(call.arguments);
      } catch (err) {
        ok = false;
        out = `tool failed: ${(err as Error).message}`;
      }
      calls.push({ name: call.name, arguments: call.arguments, ok, result: out });
      turns.push({ role: 'tool', callId: call.id, name: call.name, content: out });
    }

    trace.push({ step, text, calls, latencyMs: result.usage.latencyMs,
                 inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
  }

  return { answer: '', trace, spentUsd, steps: budget.maxSteps, stopReason: 'max_steps' };
}

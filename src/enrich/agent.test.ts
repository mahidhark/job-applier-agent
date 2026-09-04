import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, type ToolImpl } from './agent.js';
import type { Model, ToolCall, Turn } from '../ai/types.js';

/** A model that replays a scripted sequence of steps. No network. */
function scripted(steps: Array<{ text: string; toolCalls: ToolCall[] }>): Model & { seen: Turn[][] } {
  let i = 0;
  const seen: Turn[][] = [];
  return {
    id: 'test:scripted',
    seen,
    async complete() { throw new Error('not used'); },
    async parse() { throw new Error('not used'); },
    async step(_system, turns) {
      seen.push(structuredClone(turns));
      const s = steps[Math.min(i++, steps.length - 1)]!;
      return { value: s, usage: { inputTokens: 1, outputTokens: 1, latencyMs: 0 }, raw: s.text };
    },
  };
}

const tool = (name: string, costUsd: number, out = 'ok'): ToolImpl => ({
  name, description: name, parameters: { type: 'object', properties: {} }, costUsd,
  async run() { return out; },
});

const call = (name: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ id: `c-${name}`, name, arguments: args });

test('an answer with no tool calls finishes immediately', async () => {
  const run = await runAgent(scripted([{ text: 'done', toolCalls: [] }]), 'sys', 'task',
    [tool('search', 0.1)], { maxSteps: 5, maxSpendUsd: 1 });
  assert.equal(run.stopReason, 'done');
  assert.equal(run.answer, 'done');
  assert.equal(run.spentUsd, 0);
});

test('a tool result is fed back before the next step', async () => {
  const model = scripted([
    { text: '', toolCalls: [call('search')] },
    { text: 'found it', toolCalls: [] },
  ]);
  const run = await runAgent(model, 'sys', 'task', [tool('search', 0.1, 'PROFILE')],
    { maxSteps: 5, maxSpendUsd: 1 });

  assert.equal(run.answer, 'found it');
  const second = model.seen[1]!;
  const toolTurn = second.find((t) => t.role === 'tool');
  assert.ok(toolTurn && 'content' in toolTurn && toolTurn.content === 'PROFILE',
    'the tool output must reach the model');
});

test('spend is charged before the call and stops the run at the ceiling', async () => {
  const model = scripted([{ text: '', toolCalls: [call('expensive')] }]);
  const run = await runAgent(model, 'sys', 'task', [tool('expensive', 0.5)],
    { maxSteps: 5, maxSpendUsd: 0.2 });
  assert.equal(run.stopReason, 'budget');
  assert.equal(run.spentUsd, 0, 'a refused call must not be billed');
});

test('a hallucinated tool name is reported back, not silently dropped', async () => {
  const model = scripted([
    { text: '', toolCalls: [call('summon_hiring_manager')] },
    { text: 'recovered', toolCalls: [] },
  ]);
  const run = await runAgent(model, 'sys', 'task', [tool('search', 0.1)],
    { maxSteps: 5, maxSpendUsd: 1 });

  assert.equal(run.answer, 'recovered');
  assert.match(run.trace[0]!.calls[0]!.result, /no such tool/);
  assert.equal(run.spentUsd, 0);
});

test('a looping model is stopped by maxSteps', async () => {
  const run = await runAgent(scripted([{ text: '', toolCalls: [call('search')] }]),
    'sys', 'task', [tool('search', 0)], { maxSteps: 3, maxSpendUsd: 10 });
  assert.equal(run.stopReason, 'max_steps');
  assert.equal(run.steps, 3);
});

test('a throwing tool is reported to the model rather than killing the run', async () => {
  const boom: ToolImpl = {
    name: 'boom', description: 'boom', parameters: { type: 'object', properties: {} },
    costUsd: 0, async run() { throw new Error('upstream 503'); },
  };
  const run = await runAgent(
    scripted([{ text: '', toolCalls: [call('boom')] }, { text: 'handled', toolCalls: [] }]),
    'sys', 'task', [boom], { maxSteps: 5, maxSpendUsd: 1 },
  );
  assert.equal(run.answer, 'handled');
  assert.equal(run.trace[0]!.calls[0]!.ok, false);
  assert.match(run.trace[0]!.calls[0]!.result, /upstream 503/);
});

test('a model error ends the run without throwing', async () => {
  const broken: Model = {
    id: 'test:broken',
    async complete() { throw new Error('x'); },
    async parse() { throw new Error('x'); },
    async step() { throw new Error('context length exceeded'); },
  };
  const run = await runAgent(broken, 'sys', 'task', [tool('search', 0)],
    { maxSteps: 3, maxSpendUsd: 1 });
  assert.equal(run.stopReason, 'error');
  assert.match(run.error ?? '', /context length/);
});

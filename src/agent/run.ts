/**
 * Run the goal-directed agent, on either model, and record what happened.
 *
 *   npm run agent -- --provider ollama   <job-id>
 *   npm run agent -- --provider anthropic <job-id>
 *   npm run agent -- --compare            <job-id>   both, same inputs
 *
 * The comparison is the point. One goal, one tool surface, one orchestrator,
 * and the model as the only variable — so a difference in outcome is a
 * difference between the models rather than between two harnesses.
 *
 * Everything is recorded because the interesting failures of a small model in
 * an agent loop are not "wrong answer": they are naming a tool that does not
 * exist, forgetting the goal by step four, calling the same tool repeatedly,
 * or emitting the final block in the wrong shape. None of those show up in a
 * pass/fail.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../config-file.js';
import { q, recordContact } from '../store/db.js';
import type { ProviderName } from '../ai/index.js';
import type { JobPosting } from '../sources/types.js';
import { buildEnrichAgent, enrichGoal } from './enrich-agent.js';
import { closeMcp } from './mcp.js';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const jobId = args.find((a) => !a.startsWith('--') && !['ollama', 'anthropic'].includes(a));

const MAX_STEPS = Number(val('--max-steps') ?? 10);

export interface RunRecord {
  provider: string;
  jobId: string;
  ok: boolean;
  wallMs: number;
  steps: number;
  toolCalls: Array<{ name: string; ok: boolean; argsPreview: string }>;
  unknownTools: string[];
  finalText: string;
  parsed: Record<string, string> | null;
  grounded: boolean | null;
  error?: string;
}

/** The agent is asked for a fixed block; a small model often drifts from it. */
function parseFinal(text: string): Record<string, string> | null {
  const keys = ['CONTACT', 'TITLE', 'PROFILE', 'OBSERVATION', 'SOURCE', 'WHY'];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const m = new RegExp(`^${k}:\\s*(.+)$`, 'im').exec(text);
    if (m?.[1]) out[k] = m[1].trim();
  }
  return out['CONTACT'] && out['PROFILE'] ? out : null;
}

const flat = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

async function runOne(job: JobPosting, provider: ProviderName): Promise<RunRecord> {
  const config = loadConfig();
  const started = Date.now();
  const toolCalls: RunRecord['toolCalls'] = [];
  const unknownTools: string[] = [];
  let transcript = '';

  try {
    const { agent, label, toolNames } = await buildEnrichAgent({ config: config.ai, provider });
    const known = new Set(toolNames);

    const res = await agent.generate(enrichGoal(job), {
      maxSteps: MAX_STEPS,
      onStepFinish: (step: unknown) => {
        const s = step as {
          toolCalls?: Array<{ toolName?: string; args?: unknown }>;
          toolResults?: Array<{ result?: unknown }>;
        };
        for (const c of s.toolCalls ?? []) {
          const name = c.toolName ?? '(unnamed)';
          if (!known.has(name)) unknownTools.push(name);
          toolCalls.push({
            name,
            ok: known.has(name),
            argsPreview: JSON.stringify(c.args ?? {}).slice(0, 160),
          });
        }
        for (const r of s.toolResults ?? []) {
          transcript += `\n${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}`;
        }
      },
    } as never);

    const finalText = String((res as { text?: string }).text ?? '');
    const parsed = parseFinal(finalText);

    // Same grounding rule as everywhere else: an observation is only real if
    // its quoted source appears in something a tool actually returned.
    let grounded: boolean | null = null;
    if (parsed) {
      const src = parsed['SOURCE'] ?? 'NONE';
      const obs = parsed['OBSERVATION'] ?? 'NONE';
      grounded = obs === 'NONE' || (src !== 'NONE' && src.length >= 20 && flat(transcript).includes(flat(src)));
      if (parsed['CONTACT']) {
        recordContact(job.id, parsed['CONTACT'], parsed['TITLE'] ?? null,
                      parsed['PROFILE'] ?? null, `agent:${label}`,
                      grounded ? (obs === 'NONE' ? null : obs) : null);
      }
    }

    return {
      provider: label, jobId: job.id, ok: Boolean(parsed), wallMs: Date.now() - started,
      steps: toolCalls.length, toolCalls, unknownTools, finalText, parsed, grounded,
    };
  } catch (err) {
    return {
      provider, jobId: job.id, ok: false, wallMs: Date.now() - started,
      steps: toolCalls.length, toolCalls, unknownTools, finalText: '', parsed: null,
      grounded: null, error: (err as Error).message,
    };
  }
}

function report(r: RunRecord): void {
  console.log(`\n  ${r.provider}`);
  console.log(`    ${r.ok ? 'produced an answer' : 'NO USABLE ANSWER'} in ${(r.wallMs / 1000).toFixed(1)}s, ${r.steps} tool calls`);
  if (r.unknownTools.length) console.log(`    hallucinated tool names: ${[...new Set(r.unknownTools)].join(', ')}`);
  for (const c of r.toolCalls) console.log(`      ${c.ok ? '·' : '✗'} ${c.name}  ${c.argsPreview}`);
  if (r.error) console.log(`    error: ${r.error}`);
  if (r.parsed) {
    console.log(`    → ${r.parsed['CONTACT']}${r.parsed['TITLE'] ? ` — ${r.parsed['TITLE']}` : ''}`);
    console.log(`      ${r.parsed['PROFILE']}`);
    console.log(`      observation: ${r.parsed['OBSERVATION'] ?? 'NONE'}`);
    console.log(`      grounded: ${r.grounded === null ? 'n/a' : r.grounded ? 'yes' : 'NO — source not in any tool output'}`);
  } else if (r.finalText) {
    console.log(`    final text did not match the required block:\n      ${r.finalText.slice(0, 300).replace(/\n/g, '\n      ')}`);
  }
}

async function main() {
  if (!jobId) {
    console.error('\n  usage: npm run agent -- [--provider ollama|anthropic | --compare] <job-id>\n');
    process.exit(1);
  }
  const row = q<{ raw: string }>('SELECT raw FROM jobs WHERE id = ?', jobId)[0];
  if (!row) { console.error(`\n  ${jobId} is not in the database.\n`); process.exit(2); }
  const job = JSON.parse(row.raw) as JobPosting;

  console.log(`\n  ${job.company} — ${job.title}`);
  const providers: ProviderName[] = has('--compare')
    ? ['anthropic', 'ollama']
    : [(val('--provider') as ProviderName) ?? 'ollama'];

  const records: RunRecord[] = [];
  for (const p of providers) {
    const r = await runOne(job, p);
    report(r);
    records.push(r);
  }

  mkdirSync('data/runs', { recursive: true });
  const path = `data/runs/${jobId.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(records, null, 2));
  console.log(`\n  full trace: ${path}\n`);
  await closeMcp();
}

main().catch(async (err) => {
  await closeMcp();
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

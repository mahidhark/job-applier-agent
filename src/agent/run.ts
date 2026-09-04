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

/** Flags that consume the next argument. Anything else bare is the job id. */
const VALUE_FLAGS = new Set(['--provider', '--tools', '--max-steps']);

const has = (f: string) => args.includes(f);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

/**
 * A flag's VALUE is not a positional argument. An earlier version read
 * `--tools narrow <id>` as job id "narrow", which is the kind of bug that
 * only shows up the first time someone combines two flags.
 */
const positional = (() => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) { if (VALUE_FLAGS.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
})();

const jobId = positional[0];
// A full enrichment is resolve company -> find people -> read posts, and each
// actor call can need a follow-up to page its dataset. Ten was too few: the
// first Claude run was one step from an answer when it ran out.
const MAX_STEPS = Number(val('--max-steps') ?? 20);
const TOOL_PROFILE = val('--tools');

export interface RunRecord {
  provider: string;
  jobId: string;
  ok: boolean;
  wallMs: number;
  steps: number;
  toolCalls: Array<{ name: string; ok: boolean; argsPreview: string }>;
  unknownTools: string[];
  /** Why it stopped. `max_steps` is not the same failure as `no answer`. */
  stopReason: 'answered' | 'max_steps' | 'no_block' | 'error';
  finalText: string;
  /** First raw step, verbatim. Provider step shapes differ and are undocumented
   *  enough that guessing at a field name silently mislabels every tool call. */
  rawFirstStep?: unknown;
  /** Characters of tool output captured. Zero means the grounding check is
   *  broken, not that the model invented something. */
  transcriptChars: number;
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
  let rawFirstStep: unknown;

  try {
    const { agent, label, toolNames } = await buildEnrichAgent({
      config: config.ai, provider,
      ...(TOOL_PROFILE ? { toolProfile: TOOL_PROFILE } : {}),
    });
    const known = new Set(toolNames);

    const res = await agent.generate(enrichGoal(job), {
      maxSteps: MAX_STEPS,
      onStepFinish: (step: unknown) => {
        if (rawFirstStep === undefined) rawFirstStep = step;

        const s = step as {
          toolCalls?: Array<Record<string, unknown>>;
          toolResults?: Array<Record<string, unknown>>;
          content?: Array<Record<string, unknown>>;
        };

        // Mastra wraps each call as { type, runId, from, payload: { toolName, args } }
        // while the same call ALSO appears flat inside `content`. Reading both
        // counted every call twice — the first clean run reported 16 calls for
        // 8 actual ones. `toolCalls` is the authoritative list; `content` is a
        // rendering of the same events.
        const nameOf = (c: Record<string, unknown>): string | null => {
          const payload = c['payload'] as Record<string, unknown> | undefined;
          const name = payload?.['toolName'] ?? c['toolName'] ?? c['name'];
          return typeof name === 'string' ? name : null;
        };
        const argsOf = (c: Record<string, unknown>): unknown => {
          const payload = c['payload'] as Record<string, unknown> | undefined;
          return payload?.['args'] ?? c['args'] ?? c['input'] ?? {};
        };

        for (const c of s.toolCalls ?? []) {
          const name = nameOf(c);
          // Only a name we could actually read and that is absent from the
          // server's list counts as hallucinated. An unreadable shape is our
          // bug, and reporting it as the model's would be a false finding.
          if (name && !known.has(name)) unknownTools.push(name);
          toolCalls.push({
            name: name ?? '(shape unread)',
            ok: name ? known.has(name) : true,
            argsPreview: JSON.stringify(argsOf(c)).slice(0, 160),
          });
        }

        // The result lives at payload.result. Reading r.result yielded undefined
        // on every call, so the transcript was empty and the grounding check
        // reported every observation as ungrounded — a false accusation against
        // the model, which is the worst way for a verifier to fail.
        for (const r of s.toolResults ?? []) {
          const payload = r['payload'] as Record<string, unknown> | undefined;
          const v = payload?.['result'] ?? r['result'] ?? r['output'];
          if (v === undefined) continue;
          transcript += `\n${typeof v === 'string' ? v : JSON.stringify(v)}`;
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

    // Running out of steps is a budget outcome, not an inability to answer.
    const stopReason: RunRecord['stopReason'] = parsed
      ? 'answered'
      : toolCalls.length >= MAX_STEPS ? 'max_steps' : 'no_block';

    return {
      provider: label, jobId: job.id, ok: Boolean(parsed), wallMs: Date.now() - started,
      steps: toolCalls.length, toolCalls, unknownTools, stopReason, finalText,
      rawFirstStep, transcriptChars: transcript.length, parsed, grounded,
    };
  } catch (err) {
    return {
      provider, jobId: job.id, ok: false, wallMs: Date.now() - started,
      steps: toolCalls.length, toolCalls, unknownTools, stopReason: 'error',
      finalText: '', rawFirstStep, transcriptChars: transcript.length, parsed: null,
      grounded: null, error: (err as Error).message,
    };
  }
}

function report(r: RunRecord): void {
  console.log(`\n  ${r.provider}`);
  const verdict = {
    answered: 'produced an answer',
    max_steps: `RAN OUT OF STEPS (limit ${MAX_STEPS})`,
    no_block: 'stopped without the required block',
    error: 'ERRORED',
  }[r.stopReason];
  console.log(`    ${verdict} in ${(r.wallMs / 1000).toFixed(1)}s, ${r.steps} tool calls`);
  if (r.unknownTools.length) console.log(`    hallucinated tool names: ${[...new Set(r.unknownTools)].join(', ')}`);
  for (const c of r.toolCalls) console.log(`      ${c.ok ? '·' : '✗'} ${c.name}  ${c.argsPreview}`);
  if (r.error) console.log(`    error: ${r.error}`);
  if (r.parsed) {
    console.log(`    → ${r.parsed['CONTACT']}${r.parsed['TITLE'] ? ` — ${r.parsed['TITLE']}` : ''}`);
    console.log(`      ${r.parsed['PROFILE']}`);
    console.log(`      observation: ${r.parsed['OBSERVATION'] ?? 'NONE'}`);
    const g = r.grounded === null ? 'n/a'
      : r.grounded ? 'yes'
      : r.transcriptChars === 0 ? 'UNCHECKABLE — no tool output was captured'
      : 'NO — source not in any tool output';
    console.log(`      grounded: ${g}   (${r.transcriptChars} chars of tool output seen)`);
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

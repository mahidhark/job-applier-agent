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
import { TOOL_COST_USD, type EnrichOutcome } from './tools/index.js';
import { type Verdict } from './grounding.js';
import { spentLast24h } from '../store/db.js';
// The Apify connection the TOOLS use. An earlier version closed
// src/agent/mcp.ts's client instead — a different one, unused since the tool
// refactor — so a run finished its work and then hung forever on an open
// socket. Two orphaned processes were found alive on a memory-tight box.
import { closeMcp } from './apify.js';

const args = process.argv.slice(2);

/** Flags that consume the next argument. Anything else bare is the job id. */
// `--compare` is deliberately boolean. Making it value-taking meant
// `--compare <job-id>` swallowed the job id — the same class of bug that made
// `--tools narrow <job-id>` parse "narrow" as the id. Custom provider sets go
// through --providers instead.
const VALUE_FLAGS = new Set(['--provider', '--tools', '--max-steps', '--providers']);

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


export interface RunRecord {
  provider: string;
  jobId: string;
  ok: boolean;
  wallMs: number;
  steps: number;
  toolCalls: Array<{ name: string; ok: boolean; argsPreview: string }>;
  unknownTools: string[];
  /** Why it stopped. `max_steps` is not the same failure as `no answer`. */
  /** `answered_none` is a successful answer: it searched and committed that nobody is reachable. */
  stopReason: 'answered' | 'answered_none' | 'max_steps' | 'no_block' | 'error';
  finalText: string;
  /** First raw step, verbatim. Provider step shapes differ and are undocumented
   *  enough that guessing at a field name silently mislabels every tool call. */
  rawFirstStep?: unknown;
  /** Characters of tool output captured. Zero means the grounding check is
   *  broken, not that the model invented something. */
  transcriptChars: number;
  parsed: Record<string, string> | null;
  grounded: Verdict | null;
  groundingReason?: string;
  /** Tool output, truncated, so a verdict can be re-checked offline. */
  transcriptSample?: string;
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
  const transcript = { text: '' };
  let rawFirstStep: unknown;
  let committed: EnrichOutcome | null = null;

  // Budget is enforced by refusing the call, not by billing and apologising.
  const dailyLeft = config.enrich.maxSpendPerDayUsd - spentLast24h();
  let spent = 0;
  const charge = (tool: string): boolean => {
    const cost = TOOL_COST_USD[tool] ?? 0;
    if (spent + cost > Math.min(0.5, dailyLeft)) return false;
    spent += cost;
    return true;
  };

  try {
    const { agent, label, toolNames, providerOptions } = buildEnrichAgent({
      config: config.ai,
      provider,
      toolContext: { jobId: job.id, transcript, charge, onFinish: (o) => { committed = o; } },
    });
    const known = new Set(toolNames);

    const res = await agent.generate(enrichGoal(job), {
      maxSteps: MAX_STEPS,
      ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
      onStepFinish: (step: unknown) => {
        if (rawFirstStep === undefined) rawFirstStep = step;
        const s = step as { toolCalls?: Array<Record<string, unknown>> };

        const nameOf = (c: Record<string, unknown>): string | null => {
          const payload = c['payload'] as Record<string, unknown> | undefined;
          const n = payload?.['toolName'] ?? c['toolName'] ?? c['name'];
          return typeof n === 'string' ? n : null;
        };
        const argsOf = (c: Record<string, unknown>): unknown => {
          const payload = c['payload'] as Record<string, unknown> | undefined;
          return payload?.['args'] ?? c['args'] ?? c['input'] ?? {};
        };

        for (const c of s.toolCalls ?? []) {
          const name = nameOf(c);
          if (name && !known.has(name)) unknownTools.push(name);
          toolCalls.push({
            name: name ?? '(shape unread)',
            ok: name ? known.has(name) : true,
            argsPreview: JSON.stringify(argsOf(c)).slice(0, 160),
          });
        }
      },
    } as never);

    const finalText = String((res as { text?: string }).text ?? '');

    // record_contact already refused an ungrounded observation, so a committed
    // contact is grounded by construction. That is the point of enforcing it in
    // the tool rather than scoring afterwards.
    const done = committed as EnrichOutcome | null;
    const contact = done?.contact ?? null;

    const parsed = contact
      ? { CONTACT: contact.name, TITLE: contact.title, PROFILE: contact.profileUrl,
          OBSERVATION: contact.observation || 'NONE', SOURCE: contact.observationSource || 'NONE',
          WHY: contact.reasoning }
      : null;

    const grounded: Verdict | null = contact
      ? (contact.observation ? 'grounded' : 'no_claim')
      : null;

    // Committing "nobody" is an answer. Only never committing at all is not.
    const stopReason: RunRecord['stopReason'] = contact
      ? 'answered'
      : done && !done.found ? 'answered_none'
      : toolCalls.length >= MAX_STEPS ? 'max_steps' : 'no_block';

    return {
      provider: label, jobId: job.id, ok: Boolean(done), wallMs: Date.now() - started,
      steps: toolCalls.length, toolCalls, unknownTools, stopReason, finalText,
      rawFirstStep, transcriptChars: transcript.text.length,
      transcriptSample: transcript.text.slice(0, 20000), parsed, grounded,
      ...(done ? {} : { groundingReason: 'the agent committed to neither a contact nor an absence' }),
    };
  } catch (err) {
    return {
      provider, jobId: job.id, ok: false, wallMs: Date.now() - started,
      steps: toolCalls.length, toolCalls, unknownTools, stopReason: 'error',
      finalText: '', rawFirstStep, transcriptChars: transcript.text.length, parsed: null,
      grounded: null, error: (err as Error).message,
    };
  }
}

function report(r: RunRecord): void {
  console.log(`\n  ${r.provider}`);
  const verdict = {
    answered: 'produced an answer',
    answered_none: 'searched and committed that nobody is reachable',
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
    const label = {
      grounded: 'yes', not_found: 'NO — cited text is in no tool output',
      uncheckable: 'UNCHECKABLE — harness captured no tool output',
      no_claim: 'n/a — no observation claimed',
    }[r.grounded ?? 'no_claim'];
    console.log(`      grounded: ${label}   (${r.transcriptChars} chars of tool output seen)`);
  } else if (r.finalText) {
    console.log(`    final text did not match the required block:\n      ${r.finalText.slice(0, 300).replace(/\n/g, '\n      ')}`);
  }
}

async function main() {
  if (!jobId) {
    console.error(
      '\n  usage: npm run agent -- <job-id>\n' +
      '    --provider anthropic|cerebras|ollama   one provider\n' +
      '    --compare                              anthropic + cerebras\n' +
      '    --providers a,b,c                      an explicit set\n' +
      '    --tools narrow|discovery               tool surface\n' +
      '    --max-steps N                          default 20\n',
    );
    process.exit(1);
  }
  const row = q<{ raw: string }>('SELECT raw FROM jobs WHERE id = ?', jobId)[0];
  if (!row) { console.error(`\n  ${jobId} is not in the database.\n`); process.exit(2); }
  const job = JSON.parse(row.raw) as JobPosting;

  console.log(`\n  ${job.company} — ${job.title}`);
  const providers: ProviderName[] = val('--providers')
    ? (val('--providers')!.split(',').map((p) => p.trim()) as ProviderName[])
    : has('--compare')
      ? ['anthropic', 'cerebras']
      : [(val('--provider') as ProviderName) ?? 'cerebras'];

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

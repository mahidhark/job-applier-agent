/**
 * What the agent actually committed to, read back out of its own messages.
 *
 * Every scorer needs the same three things — did it commit, to whom, and what
 * did the tools return — so they are extracted once here rather than four
 * times with four subtly different opinions.
 *
 * The extraction goes through Mastra's `extractToolResults` rather than our own
 * message walking. That matters: the harness reads the run the same way the
 * framework does, so a change in message shape cannot leave the scorers quietly
 * reading nothing. Reading a field that had been renamed is precisely how a
 * working model got reported as fabricating.
 */
import { extractToolResults, type ToolResultInfo } from '@mastra/evals/scorers/utils';
import type { ScorerRunOutputForAgent } from '@mastra/core/evals';

export const RECORD_CONTACT = 'record_contact';
export const RECORD_NO_CONTACT = 'record_no_contact';
const RECORD_TOOLS = new Set([RECORD_CONTACT, RECORD_NO_CONTACT]);

export interface Commitment {
  kind: 'contact' | 'no_contact' | 'none';
  name: string;
  profileUrl: string;
  observation: string;
  observationSource: string;
  reasoning: string;
}

const NONE: Commitment = {
  kind: 'none', name: '', profileUrl: '', observation: '', observationSource: '', reasoning: '',
};

/** A `record_contact` whose grounding check refused it never happened. */
function refused(r: ToolResultInfo): boolean {
  const text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '');
  return /^"?REFUSED:/.test(text.trim());
}

export interface RunFacts {
  commitment: Commitment;
  /** Everything the evidence tools returned, concatenated. The grounding haystack. */
  transcript: string;
  /** How many tool calls were made at all, refusals included. */
  toolCallCount: number;
  /** How many calls returned evidence, i.e. were not one of the record_* tools. */
  evidenceCallCount: number;
}

export function readRun(output: ScorerRunOutputForAgent): RunFacts {
  const results = extractToolResults(output ?? []);

  const evidence = results.filter((r: ToolResultInfo) => !RECORD_TOOLS.has(r.toolName));
  const transcript = evidence
    .map((r: ToolResultInfo) => (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '')))
    .join('\n\n');

  // Last one wins: a model may be refused, correct itself, and commit again.
  let commitment: Commitment = NONE;
  for (const r of results) {
    if (r.toolName === RECORD_NO_CONTACT) {
      commitment = { ...NONE, kind: 'no_contact', reasoning: String(r.args?.['reason'] ?? '') };
    } else if (r.toolName === RECORD_CONTACT && !refused(r)) {
      const a = r.args ?? {};
      commitment = {
        kind: 'contact',
        name: String(a['name'] ?? ''),
        profileUrl: String(a['profileUrl'] ?? ''),
        observation: String(a['observation'] ?? ''),
        observationSource: String(a['observationSource'] ?? ''),
        reasoning: String(a['reasoning'] ?? ''),
      };
    }
  }

  return {
    commitment,
    transcript,
    toolCallCount: results.length,
    evidenceCallCount: evidence.length,
  };
}

/** Compare LinkedIn URLs without tripping over scheme, www or a trailing slash. */
export function urlKey(u: string): string {
  return u.toLowerCase().trim()
    .replace(/^https?:\/\//, '')
    .replace(/^[a-z]{2,3}\./, (m) => (m === 'www.' ? '' : m))
    .replace(/^www\./, '')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '');
}

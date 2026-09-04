/**
 * The scorers.
 *
 * Four questions, each its own scorer, because a single blended number tells
 * you a run got 0.6 and nothing about which half was wrong:
 *
 *   answered        did it commit to anything at all
 *   right_contact   is what it committed one of the answers Mahi accepts
 *   no_fabrication  is the person it named someone the tools actually returned
 *   grounded        is the observation supported by text a tool returned
 *
 * Trajectory — how it used the tools — is Mastra's prebuilt scorer, configured
 * below rather than reimplemented. It is the one that would have caught the
 * largest finding of 2026-09-04 without a human reading the trace: on Apify's
 * raw MCP surface a 120B model made eighteen consecutive searches and never
 * read a result. No error, no answer, nothing in any single-number score.
 *
 * `no_fabrication` and `grounded` are GATES, not scores. Naming a person who
 * does not exist, or attaching an invented sentence to a real one, is not a
 * lower-quality run — it is the one outcome that reaches a stranger's inbox and
 * cannot be taken back.
 */
import { createScorer } from '@mastra/core/evals';
import { createTrajectoryScorerCode } from '@mastra/evals/scorers/prebuilt';
import { checkGrounding, normalise } from '../../agent/grounding.js';
import { isResolvableProfileUrl } from '../../agent/profile.js';
import type { EvalCase } from '../cases.js';
import { readRun, urlKey, type RunFacts } from './commitment.js';

/**
 * Thrown when a run cannot be scored at all. Never a zero — see `grounded`.
 *
 * Mastra wraps a step's throw in a `ScorerRunError` and rebuilds the cause, so
 * `instanceof` does not survive the pipeline. The sentinel in the message does,
 * which is why `isUnscoreable` matches on that rather than on the class.
 */
export const UNSCOREABLE = 'UNSCOREABLE:';

export class UnscoreableRun extends Error {
  override readonly name = 'UnscoreableRun';
  constructor(reason: string) {
    super(`${UNSCOREABLE} ${reason}`);
  }
}

/** Did this failure mean "the harness is broken", rather than "the model was wrong"? */
export function isUnscoreable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 8; depth++) {
    if (e instanceof UnscoreableRun) return true;
    const o = e as { name?: unknown; message?: unknown; cause?: unknown };
    if (o.name === 'UnscoreableRun') return true;
    if (typeof o.message === 'string' && o.message.includes(UNSCOREABLE)) return true;
    e = o.cause;
  }
  return false;
}

const facts = ({ run }: { run: { output?: any } }): RunFacts => readRun(run.output ?? []);
const theCase = (run: { groundTruth?: any }): EvalCase => run.groundTruth as EvalCase;

/**
 * Did it commit?
 *
 * Committing "nobody" counts. It is an answer, and on a nobody_findable case it
 * is the right one. The runner used to infer that from free text and label it a
 * failure while the prompt told the model to do exactly that — correct
 * behaviour scored as failure. Making it a tool call made it scoreable; this
 * scorer is where that becomes explicit.
 */
export const answered = createScorer({
  id: 'answered',
  description: 'The agent committed to a contact or to an absence, rather than running out of steps.',
  type: 'agent',
})
  .preprocess(facts)
  .generateScore(({ results }) => (results.preprocessStepResult.commitment.kind === 'none' ? 0 : 1))
  .generateReason(({ results, score }) =>
    score === 1
      ? `committed: ${results.preprocessStepResult.commitment.kind}`
      : `made ${results.preprocessStepResult.toolCallCount} tool call(s) and never committed`,
  );

/**
 * Is the answer one Mahi would accept?
 *
 * The case shape carries this on its own, so there is no separate scorer for
 * "should have said nobody": a nobody_findable case has an empty acceptable
 * list, and committing no contact is then the correct answer. One scorer, both
 * directions.
 */
export const rightContact = createScorer({
  id: 'right_contact',
  description: 'The committed answer matches what this case accepts, including "nobody".',
  type: 'agent',
})
  .preprocess(facts)
  .generateScore(({ run, results }) => {
    const c = theCase(run);
    const { commitment } = results.preprocessStepResult;
    if (!c.acceptable.length) return commitment.kind === 'no_contact' ? 1 : 0;
    if (commitment.kind !== 'contact') return 0;
    return c.acceptable.some((a) => urlKey(a.profileUrl) === urlKey(commitment.profileUrl)) ? 1 : 0;
  })
  .generateReason(({ run, results, score }) => {
    const c = theCase(run);
    const { commitment } = results.preprocessStepResult;
    if (score === 1) return c.acceptable.length ? `${commitment.name} is accepted` : 'correctly found nobody';
    if (!c.acceptable.length) return `named ${commitment.name || 'someone'} on a case where nobody is reachable`;
    if (commitment.kind !== 'contact') return `committed no contact; ${c.acceptable.length} would have been accepted`;
    return `${commitment.name} is not among the ${c.acceptable.length} accepted contact(s)`;
  });

/**
 * Is the person real?
 *
 * A wrong answer and an invented one are different failures. Naming a genuine
 * employee who is not the best contact is a judgement call; naming somebody who
 * appears in no tool output is a fabrication, and it is the only failure here
 * that reaches a real human. Hence a gate, and hence separate from
 * `right_contact` — which would otherwise mark both 0 and hide the difference.
 */
export const noFabrication = createScorer({
  id: 'no_fabrication',
  description: 'Any person the agent named appears in what the tools actually returned.',
  type: 'agent',
})
  .preprocess(facts)
  .generateScore(({ results }) => {
    const { commitment, transcript } = results.preprocessStepResult;
    if (commitment.kind !== 'contact') return 1;
    const hay = normalise(transcript);
    const byUrl = commitment.profileUrl && hay.includes(normalise(urlKey(commitment.profileUrl)));
    const byName = commitment.name && hay.includes(normalise(commitment.name));
    return byUrl || byName ? 1 : 0;
  })
  .generateReason(({ results, score }) => {
    const { commitment } = results.preprocessStepResult;
    if (commitment.kind !== 'contact') return 'named nobody, so nobody was invented';
    return score === 1
      ? `${commitment.name} appears in tool output`
      : `${commitment.name} (${commitment.profileUrl}) appears in NO tool output`;
  });

/**
 * Is the observation supported?
 *
 * `record_contact` already refuses an ungrounded commit, so in normal operation
 * this is near-constant. Its value is catching the regression that removes that
 * refusal, which would otherwise stay invisible until somebody received an
 * invented sentence about themselves.
 *
 * Two verdicts deliberately do not score zero:
 *
 *   no_claim     the agent made no observation. Claiming nothing is not a
 *                grounding failure, and penalising it teaches the model to
 *                invent something rather than leave the field empty.
 *   uncheckable  tools were called but returned nothing to check against.
 *                That is a broken harness, and it THROWS rather than scoring.
 *                Scoring a harness fault as a model failure is the single
 *                mistake that wasted the most time on this project; failing
 *                loud is the fix.
 *
 * Zero tool calls is different again: nothing was consulted, so an observation
 * came from nowhere. That is a model failure and scores zero.
 */
export const grounded = createScorer({
  id: 'grounded',
  description: 'Any observation is supported by cited text that appears in tool output.',
  type: 'agent',
})
  .preprocess(facts)
  .analyze(({ results }) => {
    const { commitment, transcript, evidenceCallCount } = results.preprocessStepResult;
    if (commitment.kind !== 'contact') {
      return { verdict: 'no_claim' as const, reason: 'no contact was committed' };
    }
    if (!commitment.observation.trim()) {
      return { verdict: 'no_claim' as const, reason: 'no observation was claimed' };
    }
    if (evidenceCallCount === 0) {
      return {
        verdict: 'not_found' as const,
        reason: 'an observation was made without calling any evidence tool',
      };
    }
    const g = checkGrounding(commitment.observation, commitment.observationSource, transcript);
    if (g.verdict === 'uncheckable') {
      throw new UnscoreableRun(
        `${evidenceCallCount} evidence tool call(s) returned nothing to check against. ` +
        'This is a harness fault and must not be scored as a model failure.',
      );
    }
    return { verdict: g.verdict, reason: g.reason };
  })
  .generateScore(({ results }) => (results.analyzeStepResult.verdict === 'not_found' ? 0 : 1))
  .generateReason(({ results }) => results.analyzeStepResult.reason);

/**
 * How it used the tools.
 *
 * Mastra's prebuilt scorer, not ours. It scores four dimensions at once —
 * whether the expected steps happened, whether the run was efficient
 * (`maxSteps`, `noRedundantCalls`), whether anything forbidden was called, and
 * whether tools were failing — which is more than the loop detector this
 * project would have written, and it is already tested upstream.
 *
 * The defaults below describe the shape of a competent run: find the company,
 * look at people, commit. `ordering: 'relaxed'` because reading someone's posts
 * before committing is good practice, not a deviation, and because a model that
 * has to fall back to the second people-source takes a longer path to the same
 * correct answer.
 *
 * `maxSteps: 12` is a budget, not a ceiling on the loop: exceeding it lowers
 * the efficiency sub-score rather than killing the run. A ceiling reported as
 * failure is what turned a run one step from finishing into "NO USABLE ANSWER".
 */
export const trajectory = createTrajectoryScorerCode({
  defaults: {
    steps: [
      { name: 'resolve_company', stepType: 'tool_call' },
      { name: 'find_people_at_company', stepType: 'tool_call' },
      { name: 'record_contact', stepType: 'tool_call' },
    ],
    ordering: 'relaxed',
    maxSteps: 12,
    noRedundantCalls: true,
  },
});

/**
 * Was the agent given anything it could judge on?
 *
 * THIS SCORER GRADES US, NOT THE MODEL. Every other scorer here asks whether
 * the agent answered well. None of them asked whether the evidence it was
 * handed was fit to answer from — and that blind spot cost a full day.
 *
 * `linkedin-company-employees` was being called in Short mode, which returns
 * no `headline` and an opaque member id in place of a profile URL. So on the
 * only source that was answering, the agent was asked to tell a recruiter from
 * a hiring manager with no job titles in front of it, and any answer it did
 * commit carried a link nobody could open. Nothing in the harness noticed,
 * because the harness only ever looked at the answer.
 *
 * A low score here is a bug report about the tools. It is deliberately NOT a
 * gate: the model did not cause it and must not be penalised for it — the same
 * rule as `grounded` refusing to score an empty transcript. When this scorer
 * drops, read the tool layer, not the trace.
 */
export const evidenceUsable = createScorer({
  id: 'evidence_usable',
  description: 'The tool output the agent was given had job titles and openable profile URLs.',
  type: 'agent',
})
  .preprocess(facts)
  .analyze(({ results }) => {
    const { transcript, evidenceCallCount } = results.preprocessStepResult;
    if (!evidenceCallCount) return { rate: null, detail: 'no evidence tools were called' };

    const urls = transcript.match(/https?:\/\/[^\s)\]]*linkedin\.com\/in\/[^\s)\]]*/gi) ?? [];
    const titleless = (transcript.match(/no title given/g) ?? []).length;
    const people = urls.length;
    if (!people) return { rate: null, detail: 'no people came back at all' };

    const openable = urls.filter(isResolvableProfileUrl).length;
    const withTitle = people - Math.min(titleless, people);
    // Both halves have to hold: a name you cannot judge is as useless as a
    // person you cannot reach.
    const rate = (openable / people) * (withTitle / people);
    return {
      rate,
      detail: `${openable}/${people} profile URLs open, ${withTitle}/${people} carry a job title`,
    };
  })
  .generateScore(({ results }) => results.analyzeStepResult.rate ?? 1)
  .generateReason(({ results }) => {
    const { rate, detail } = results.analyzeStepResult;
    if (rate === null) return `${detail} — nothing to judge the evidence on`;
    return rate === 1
      ? `evidence was complete: ${detail}`
      : `EVIDENCE WAS THIN — ${detail}. This is a fault in the tool layer, not the model.`;
  });

/** Must all score 1. A run that fails one of these is not a worse run, it is a wrong one. */
export const GATES = [noFabrication, grounded];

/** Scored and averaged, per provider, per case. */
export const SCORERS = [answered, rightContact];

/**
 * Graded, reported separately, and never mixed into the model's score.
 *
 * Averaging a harness measurement into a model comparison is how a broken tool
 * becomes "the small model is worse".
 */
export const HARNESS_SCORERS = [evidenceUsable];

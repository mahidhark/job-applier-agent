/**
 * The judged scorer: was this a sensible person to approach?
 *
 * `right_contact` only knows the contacts Mahi wrote down. That list is his
 * best answer, not an exhaustive one — at a sixty-person company a founder, a
 * Head of Product and the hiring manager are all defensible, and he will not
 * have listed every one. So an agent can pick a genuinely good person and score
 * zero, which over a few sprints would tune the system towards agreeing with
 * the list rather than being right.
 *
 * This scorer catches that: it grades the choice on its merits. It does not
 * replace `right_contact` — a judge is easier to talk round than a URL match —
 * it sits beside it, and a case where the two disagree is the interesting one
 * to read.
 *
 * BLIND BY CONSTRUCTION. `rubricFor` takes an `EvalCase` and nothing else, so
 * there is no path by which the judge learns which model produced the answer.
 * That is not a nicety: a comparison judged by one of its own contestants
 * flatters that contestant, and this scorer exists specifically to compare a
 * small local model against a large hosted one.
 *
 * The judge is still an LLM grading an LLM, so its verdicts are evidence, not
 * ground truth. Real ground truth arrives when somebody replies (§2.4).
 */
import { createRubricScorer } from '@mastra/evals/scorers/prebuilt';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { EvalCase } from '../cases.js';

export interface RubricCriterion {
  id: string;
  description: string;
  required?: boolean;
}

/**
 * What makes a contact right, stated per case.
 *
 * Deliberately about the ROLE and the EVIDENCE, never about the name on Mahi's
 * list: a rubric that named his answer would just be `right_contact` with a
 * language model bolted on, and would score a better choice as wrong for the
 * same reason.
 */
export function rubricFor(c: EvalCase): RubricCriterion[] {
  const base: RubricCriterion[] = [
    {
      id: 'real',
      description:
        `The person named is presented as currently working at ${c.companyName}, ` +
        'and that is supported by what the tools returned rather than asserted.',
    },
    {
      id: 'decides',
      description:
        `The person plausibly influences hiring for "${c.title}" — they lead the team, ` +
        'the function, or the company. An unrelated employee does not qualify.',
    },
    {
      id: 'not_a_recruiter',
      description:
        'The person is not an agency recruiter or a generic careers inbox. An in-house ' +
        'talent lead at the company is acceptable only if no line manager was findable.',
      required: c.shape === 'names_recruiter',
    },
    {
      id: 'reasoned',
      description:
        'The stated reasoning explains why this person rather than the others it saw, ' +
        'rather than restating their job title.',
    },
  ];

  if (c.shape === 'nobody_findable') {
    return [{
      id: 'nobody',
      description:
        'The agent committed that no contact could be found, and said what it tried. ' +
        'Naming any person at all fails this criterion.',
    }];
  }
  return base;
}

/**
 * Build the judge.
 *
 * The rubric is passed per data item through the request context under
 * `rubric`, which is how the prebuilt scorer takes a dynamic checklist — so one
 * scorer instance grades every case against its own criteria.
 */
export function rightPerson(model: MastraModelConfig) {
  return createRubricScorer({ model });
}

/** The per-item request context that carries this case's rubric to the judge. */
export function judgeContext(c: EvalCase): { rubric: RubricCriterion[] } {
  return { rubric: rubricFor(c) };
}

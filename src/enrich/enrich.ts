/**
 * Resolve who to approach about one role, and find something true to say.
 *
 * This is the only place the system reasons rather than computes. The task is
 * genuinely branching — the job poster may be the hiring manager, a recruiter,
 * or absent entirely, and the right next move differs in each case — so it is
 * an agent with tools rather than a fixed sequence.
 *
 * It runs on the handful of postings that already cleared the gates, never on
 * the thousands that did not. That ordering is the cost model.
 */
import type { AgentConfig } from '../config-file.js';
import { modelForTask } from '../ai/index.js';
import { spentLast24h, setState } from '../store/db.js';
import { runAgent, type AgentRun } from './agent.js';
import { enrichTools, type EnrichResult } from './tools.js';
import type { JobPosting } from '../sources/types.js';

const SYSTEM = `You find the right person to approach about a job opening, and one true thing to say to them.

You are working for a candidate who is applying. Your output decides who they message, so a confident wrong answer costs them a real opportunity.

HOW TO WORK

Start from what the posting already gives you. If it names someone who posted the job, judge whether they are the hiring manager or a recruiter — a title like "Talent Partner" or "People & Talent" is a recruiter. A recruiter is a usable contact but a weaker one than the person who owns the team.

If nobody is named, or the named person is a recruiter and the company is small enough that the hiring manager is findable, search the company for the person who would own this role. For a product role that is a Head of Product, Product Director, CPO, or at a small company a founder.

Once you have a candidate, read their recent posts. You are looking for one specific, true observation that a short message could open with. Something they wrote about, a decision they described, a problem they named. Not their job title, and not a compliment.

WHAT MAKES A GOOD ANSWER

The observation must come from something you actually read. If their posts are empty or irrelevant, say so plainly and record the contact with an empty observation rather than inventing one. A fabricated observation is worse than none: it will be sent to a real person who will know it is false.

Prefer the person who owns the work over the person who processes applications, and prefer someone who posts over someone silent — an active profile is far likelier to accept a request.

BUDGET

Every search costs money. Do not search a company if the posting already names the hiring manager. Do not read posts for more than two people. When you have a defensible answer, call record_contact and stop.

If you cannot find anyone, say so in your reply and do not call record_contact.`;

export interface EnrichOutcome {
  jobId: string;
  result: EnrichResult | null;
  run: AgentRun;
}

export async function enrichJob(job: JobPosting, config: AgentConfig): Promise<EnrichOutcome> {
  const remaining = config.enrich.maxSpendPerDayUsd - spentLast24h();
  if (remaining <= 0) {
    return {
      jobId: job.id, result: null,
      run: { answer: '', trace: [], spentUsd: 0, steps: 0, stopReason: 'budget',
             error: 'daily enrichment budget exhausted' },
    };
  }

  let result: EnrichResult | null = null;
  const tools = enrichTools(job.id, (r) => { result = r; });

  const task = [
    `Role: ${job.title}`,
    `Company: ${job.company}`,
    job.companyLinkedinUrl ? `Company LinkedIn: ${job.companyLinkedinUrl}` : null,
    job.companySize ? `Company size: about ${job.companySize} people` : null,
    job.location ? `Location: ${job.location}` : null,
    '',
    job.contactName
      ? `The posting names ${job.contactName}${job.contactTitle ? `, "${job.contactTitle}"` : ''}` +
        `${job.contactProfileUrl ? ` (${job.contactProfileUrl})` : ''} as having posted it.`
      : 'The posting does not name who posted it.',
    '',
    'Job description:',
    job.description.slice(0, 4000),
  ].filter(Boolean).join('\n');

  const model = modelForTask(config.ai, 'tools');
  const run = await runAgent(model, SYSTEM, task, tools, {
    maxSteps: 8,
    maxSpendUsd: Math.min(0.5, remaining),
  });

  if (result) setState(job.id, 'enriched');
  return { jobId: job.id, result, run };
}

/**
 * A goal-directed agent, orchestrated by Mastra, over Apify's MCP tools.
 *
 * This is not a pipeline with a model in it. The agent is given an outcome and
 * the whole Apify tool surface, and decides at runtime what to search, which
 * results are worth pursuing, and when it has enough. Discovering that an
 * actor exists and calling it is part of the job rather than something a
 * developer anticipated.
 *
 * The reason for building it this way is testable rather than aesthetic: if a
 * 3B model can hold a goal across six or eight tool calls and exercise
 * judgement over what comes back, then most of this system's deterministic
 * scaffolding is unnecessary. That is the hypothesis, and the run harness
 * measures it against Claude on identical inputs.
 */
import { Agent } from '@mastra/core/agent';
import type { AiConfig, ProviderName } from '../ai/index.js';
import { agentModel, modelLabel } from './model.js';
import { apifyTools } from './mcp.js';

export const GOAL_SYSTEM = `You find the right person to approach about a job opening, and one true thing to say to them.

Someone is applying for this role. What you decide determines who they message, so a confident wrong answer costs them a real opportunity.

YOU HAVE APIFY'S TOOL SURFACE

You can search Apify's store for actors, read what an actor does and what input it takes, and run one. Nothing is pre-wired for you. If you need LinkedIn company data, profiles, or someone's recent posts, find the actor that does it and call it. Read an actor's input schema before running it rather than guessing at field names.

WHAT DONE LOOKS LIKE

A named person, their role, their LinkedIn profile URL, and either one specific observation drawn from something you actually read, or an explicit statement that you found none.

HOW TO JUDGE WHAT COMES BACK

A job poster is not always the hiring manager. A title like "Talent Partner", "People & Talent" or "Recruiter" is someone who processes applications; the person who owns the team is a better contact. For a product role that is a Head of Product, Product Director, CPO, or at a small company a founder.

Company names are ambiguous. When a search returns several, pick using the website, size and location you were given, and say which you chose and why.

An observation must come from text you actually read. Quote it. Never write an observation from a job title or from what you assume a company cares about — it will be sent to a real person who will know it is invented. If the posts are empty or irrelevant, say so; no observation is a fine answer, a fabricated one is not.

COST

Every actor run costs money. Do not search for a company whose LinkedIn URL you were already given. Do not read posts for more than two people. Stop when you have a defensible answer.

FINISHING

End with a plain-text block, and nothing after it:

CONTACT: <name>
TITLE: <their role>
PROFILE: <linkedin url>
OBSERVATION: <one sentence, or NONE>
SOURCE: <the exact text your observation came from, or NONE>
WHY: <why this person and not the others>`;

export interface EnrichAgentOptions {
  config: AiConfig;
  provider?: ProviderName;
}

export async function buildEnrichAgent({ config, provider }: EnrichAgentOptions) {
  const tools = await apifyTools();

  const agent = new Agent({
    id: 'enrich',
    name: 'enrich',
    instructions: GOAL_SYSTEM,
    model: agentModel(config, provider),
    tools: tools as never,
  });

  return { agent, label: modelLabel(config, provider), toolNames: Object.keys(tools) };
}

/** The goal, stated as the task rather than as a procedure. */
export function enrichGoal(job: {
  title: string; company: string; location: string | null;
  companySize: number | null; companyUrl: string | null;
  companyLinkedinUrl: string | null;
  contactName: string | null; contactTitle: string | null; contactProfileUrl: string | null;
  description: string;
}): string {
  return [
    `Find who to approach about this role, and one true thing to say to them.`,
    ``,
    `Role: ${job.title}`,
    `Company: ${job.company}`,
    job.companyUrl ? `Company website: ${job.companyUrl}` : null,
    job.companyLinkedinUrl ? `Company LinkedIn: ${job.companyLinkedinUrl}` : null,
    job.companySize ? `Company size: about ${job.companySize} people` : null,
    job.location ? `Location: ${job.location}` : null,
    ``,
    job.contactName
      ? `The posting names ${job.contactName}${job.contactTitle ? `, "${job.contactTitle}"` : ''}` +
        `${job.contactProfileUrl ? ` (${job.contactProfileUrl})` : ''} as having posted it.`
      : `The posting does not say who posted it.`,
    ``,
    `Job description:`,
    job.description.slice(0, 3000),
  ].filter((l) => l !== null).join('\n');
}

/**
 * The tools the enrich agent may use, as Mastra tools.
 *
 * WHY THESE ARE WRAPPERS AND NOT RAW APIFY MCP
 *
 * Measured 2026-09-04: gpt-oss-120b given Apify's raw MCP surface burned all
 * twenty steps making eighteen consecutive profile searches and never once
 * read a result. Apify's pattern is actor call -> datasetId -> a separate
 * get-dataset-items, which asks the model to manage an async job lifecycle.
 * From its point of view nothing ever came back, so it kept rephrasing the
 * query. Claude alternated search/read correctly; a 120B model did not.
 *
 * A 4B model has no chance on that surface, so fixing it is a prerequisite to
 * any local model working rather than a later optimisation. These wrappers
 * hide the lifecycle: one call in, formatted text out.
 *
 * Three further consequences, each deliberate:
 *   - the model cannot name an arbitrary actor, so it cannot choose a bill
 *   - cost per call is known before it happens
 *   - the schema stays small enough for a small model to hold
 *
 * ON JUDGEMENT AND HOW IT IS CHECKED
 *
 * Everything judgemental happens here: recruiter or hiring manager, which of
 * ten results owns the work, whether a post is a usable observation. None of
 * that is verifiable by reading the model's own reasoning. So the observation
 * it commits to must be CITED, and record_contact refuses when the quote does
 * not appear in something a tool actually returned. Enforced in the tool
 * rather than scored afterwards, because a post-hoc score only tells you that
 * something false has already reached a person.
 */
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { recordContact, recordSpend } from '../../store/db.js';
import { runActorViaMcp } from '../../enrich/mcp.js';
import { checkGrounding } from '../grounding.js';

const COMPANY_SEARCH = 'harvestapi/linkedin-company';
const PROFILE_SEARCH = 'harvestapi/linkedin-profile-search';
/**
 * Fallback for PROFILE_SEARCH, which returned zero rows for every company on
 * 2026-09-04 — Booking.com included — having worked three hours earlier. One
 * source for the step that turns "I know the company" into "here are its
 * people" is a single point of failure, and it failed.
 *
 * Note the enum trap: this actor's profileScraperMode values carry the price
 * inside them ("Short ($4 per 1k)") while PROFILE_SEARCH takes a plain
 * "Short". Same field name, same publisher, different valid values.
 */
const COMPANY_EMPLOYEES = 'harvestapi/linkedin-company-employees';
const PROFILE_POSTS = 'harvestapi/linkedin-profile-posts';

interface CompanyHit {
  name?: string; linkedinUrl?: string; website?: string | null;
  employeeCount?: number; tagline?: string;
  locations?: Array<{ parsed?: { text?: string } }>;
}
interface ShortProfile {
  firstName?: string; lastName?: string; headline?: string;
  linkedinUrl?: string; location?: { linkedinText?: string };
}
interface Post { content?: string; text?: string; postedAt?: string }

export interface EnrichResult {
  name: string;
  title: string;
  profileUrl: string;
  observation: string;
  observationSource: string;
  reasoning: string;
}

/** Declared cost per call, charged against the run budget before it happens. */
export const TOOL_COST_USD: Record<string, number> = {
  resolve_company: 0.005,
  find_people_at_company: 0.1,
  find_employees_at_company: 0.05,
  read_recent_posts: 0.02,
  record_contact: 0,
};

export interface EnrichToolContext {
  jobId: string;
  /** Everything the tools have returned this run; record_contact cites against it. */
  transcript: { text: string };
  onFinish: (r: EnrichResult) => void;
  /** Returns false when the run has spent its budget. */
  charge: (tool: string) => boolean;
}

const renderProfiles = (rows: ShortProfile[]): string =>
  rows.map((p) => {
    const n = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || '(no name)';
    return `${n} — ${p.headline ?? 'no headline'}\n  ${p.linkedinUrl ?? ''}` +
           `${p.location?.linkedinText ? `\n  ${p.location.linkedinText}` : ''}`;
  }).join('\n\n');

export function buildEnrichTools(ctx: EnrichToolContext) {
  const remember = (s: string) => { ctx.transcript.text += `\n${s}`; return s; };
  const refuse = (tool: string) =>
    `REFUSED: this run has spent its budget and cannot call ${tool} again. ` +
    `Finish with what you already have.`;

  const resolve_company = createTool({
    id: 'resolve_company',
    description:
      'Find a company on LinkedIn by name and get its LinkedIn URL. Needed before searching ' +
      'for people, unless the task already gives you a company LinkedIn URL. Returns several ' +
      'candidates when the name is ambiguous — pick using the website, size and location in ' +
      'the task, and say which you chose and why.',
    inputSchema: z.object({
      name: z.string().describe('The company name as the job posting gives it'),
    }),
    execute: async ({ name }) => {
      if (!ctx.charge('resolve_company')) return refuse('resolve_company');
      const rows = (await runActorViaMcp(COMPANY_SEARCH, { searches: [name] }, 5)) as CompanyHit[];
      recordSpend(COMPANY_SEARCH, TOOL_COST_USD['resolve_company']!, ctx.jobId);
      if (!rows.length) return remember(`No company on LinkedIn matched "${name}".`);
      return remember(rows.map((c) =>
        [`${c.name ?? '(no name)'} — ${c.linkedinUrl ?? 'no url'}`,
         c.website ? `  website: ${c.website}` : null,
         c.employeeCount ? `  employees: ${c.employeeCount}` : null,
         c.locations?.[0]?.parsed?.text ? `  location: ${c.locations[0].parsed.text}` : null,
         c.tagline ? `  tagline: ${c.tagline}` : null,
        ].filter(Boolean).join('\n')).join('\n\n'));
    },
  });

  const find_people_at_company = createTool({
    id: 'find_people_at_company',
    description:
      'Find people at a company on LinkedIn, optionally filtered by job title. Use when the ' +
      'posting names nobody, or names a recruiter and you want whoever owns the team.',
    inputSchema: z.object({
      companyLinkedinUrl: z.string().describe('Full LinkedIn company URL'),
      jobTitles: z.array(z.string()).optional()
        .describe('Titles to look for, e.g. ["Head of Product", "Founder"]'),
    }),
    execute: async ({ companyLinkedinUrl, jobTitles }) => {
      if (!ctx.charge('find_people_at_company')) return refuse('find_people_at_company');
      const rows = (await runActorViaMcp(PROFILE_SEARCH, {
        profileScraperMode: 'Short',
        currentCompanies: [companyLinkedinUrl],
        ...(jobTitles?.length ? { currentJobTitles: jobTitles } : {}),
        maxItems: 10,
      }, 10)) as ShortProfile[];
      recordSpend(PROFILE_SEARCH, TOOL_COST_USD['find_people_at_company']!, ctx.jobId);

      if (!rows.length) {
        return remember(
          'No profiles returned by this source. That can mean the company has nobody ' +
          'matching, or that this source is having trouble — it cannot tell you which. ' +
          'find_employees_at_company reads the same data from a different source; if you ' +
          'have not tried it for this company, it is worth one call.',
        );
      }
      return remember(renderProfiles(rows));
    },
  });

  /**
   * A second source for the same question.
   *
   * Exposed as its own tool rather than wired as an automatic fallback. An
   * earlier version silently retried on empty, which took the decision away
   * from the model on the grounds that it could not tell an outage from a real
   * empty result. That reasoning was wrong: the right action is the same
   * either way, so the decision never needed the diagnosis. The model gets the
   * option and the information; it chooses.
   */
  const find_employees_at_company = createTool({
    id: 'find_employees_at_company',
    description:
      'Find people at a company on LinkedIn using a DIFFERENT source from ' +
      'find_people_at_company. Use it when that tool returns nothing, or when you want to ' +
      'confirm an empty result before concluding a company has nobody suitable. Same kind of ' +
      'answer, independent pipe.',
    inputSchema: z.object({
      companyLinkedinUrl: z.string().describe('Full LinkedIn company URL'),
      jobTitles: z.array(z.string()).optional().describe('Titles to look for'),
    }),
    execute: async ({ companyLinkedinUrl, jobTitles }) => {
      if (!ctx.charge('find_employees_at_company')) return refuse('find_employees_at_company');
      const rows = (await runActorViaMcp(COMPANY_EMPLOYEES, {
        // This actor puts the price inside the enum value; PROFILE_SEARCH takes
        // a plain "Short". Same field name, same publisher, different values.
        profileScraperMode: 'Short ($4 per 1k)',
        companies: [companyLinkedinUrl],
        ...(jobTitles?.length ? { jobTitles } : {}),
        maxItems: 10,
      }, 10)) as ShortProfile[];
      recordSpend(COMPANY_EMPLOYEES, TOOL_COST_USD['find_employees_at_company']!, ctx.jobId);

      if (!rows.length) {
        return remember(
          'No profiles from this source either. Two independent sources returning nothing ' +
          'is reasonable evidence the company has nobody matching your filters.',
        );
      }
      return remember(renderProfiles(rows));
    },
  });

  const read_recent_posts = createTool({
    id: 'read_recent_posts',
    description:
      'Read what a person has posted on LinkedIn recently. This is where an observation comes ' +
      'from. Someone who posts is also likelier to accept a connection request.',
    inputSchema: z.object({ profileUrl: z.string().describe('Their LinkedIn profile URL') }),
    execute: async ({ profileUrl }) => {
      if (!ctx.charge('read_recent_posts')) return refuse('read_recent_posts');
      const rows = (await runActorViaMcp(PROFILE_POSTS, {
        targetUrls: [profileUrl], maxPosts: 5, postedLimit: 'year',
      }, 5)) as Post[];
      recordSpend(PROFILE_POSTS, TOOL_COST_USD['read_recent_posts']!, ctx.jobId);
      if (!rows.length) {
        return remember('No recent posts. This person is not active on LinkedIn.');
      }
      return remember(rows.map((p, i) =>
        `[${i + 1}] ${p.postedAt ?? ''}\n${(p.content ?? p.text ?? '').slice(0, 600)}`,
      ).join('\n\n'));
    },
  });

  const record_contact = createTool({
    id: 'record_contact',
    description:
      'Commit to an answer and finish. If you have an observation you MUST quote the exact ' +
      'text it came from in observationSource — this is checked against what the tools ' +
      'returned and the call is refused if the quote is not found. If you have no real ' +
      'observation, leave both observation fields empty rather than inventing one.',
    inputSchema: z.object({
      name: z.string(),
      title: z.string().optional().describe('Their role, as their profile states it'),
      profileUrl: z.string(),
      observation: z.string().optional()
        .describe('One specific true thing a message could open with. May be empty.'),
      observationSource: z.string().optional()
        .describe('VERBATIM text copied from a tool result that the observation rests on'),
      reasoning: z.string().describe('Why this person rather than the others. One or two sentences.'),
    }),
    execute: async (input) => {
      const observation = (input.observation ?? '').trim();
      const source = (input.observationSource ?? '').trim();

      const g = checkGrounding(observation, source, ctx.transcript.text);
      if (g.verdict === 'not_found') {
        return `REFUSED: ${g.reason}. Copy the text exactly from a tool result, or call ` +
               `again with both observation fields empty.`;
      }

      const result: EnrichResult = {
        name: input.name,
        title: input.title ?? '',
        profileUrl: input.profileUrl,
        observation,
        observationSource: source,
        reasoning: input.reasoning,
      };
      recordContact(ctx.jobId, result.name, result.title || null, result.profileUrl || null,
                    'enrich-agent', observation || null);
      ctx.onFinish(result);
      return 'Recorded. You are done — reply with a one-line summary and call no more tools.';
    },
  });

  return {
    resolve_company,
    find_people_at_company,
    find_employees_at_company,
    read_recent_posts,
    record_contact,
  };
}

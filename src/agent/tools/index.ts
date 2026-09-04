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
import { recordContact, recordSpend, recordActorCall, actorHealth } from '../../store/db.js';
import { runActorViaMcp } from '../apify.js';
import { checkGrounding } from '../grounding.js';
import { renderProfiles, isResolvableProfileUrl, type RawProfile } from '../profile.js';

const COMPANY_SEARCH = 'harvestapi/linkedin-company';
const PROFILE_SEARCH = 'harvestapi/linkedin-profile-search';
/**
 * Fallback for PROFILE_SEARCH, which returned zero rows for every company on
 * 2026-09-04 — Booking.com included — having worked three hours earlier. One
 * source for the step that turns "I know the company" into "here are its
 * people" is a single point of failure, and it failed.
 *
 * Caveat learned later the same day: two sources are not independent when one
 * account pays for both. That emptiness was almost certainly an exhausted
 * Apify quota, which takes out every actor at once. apify.ts raises on it now,
 * so this fallback covers a source failing rather than the bill failing.
 *
 * Note the enum trap: this actor's profileScraperMode values carry the price
 * inside them ("Short ($4 per 1k)") while PROFILE_SEARCH takes a plain
 * "Short". Same field name, same publisher, different valid values.
 */
const COMPANY_EMPLOYEES = 'harvestapi/linkedin-company-employees';
const PROFILE_POSTS = 'harvestapi/linkedin-profile-posts';

/**
 * Exactly what `normaliseProfile` reads, and nothing else.
 *
 * A full LinkedIn profile is 66k-109k characters — measured, one at 109,425 —
 * because every job in the person's history carries the whole employer object.
 * Ten of them is most of a megabyte per call. None of it reaches the model, but
 * all of it crosses the transport and gets parsed, and there is no reason to
 * move a megabyte to render six lines.
 */
const PROFILE_FIELDS = [
  'firstName', 'lastName', 'headline', 'summary', 'linkedinUrl', 'publicIdentifier',
  'hiring', 'location.linkedinText',
  'currentPositions.title', 'currentPositions.companyName',
  'currentPositions.current', 'currentPositions.tenureAtCompany',
].join(',');

interface CompanyHit {
  name?: string; linkedinUrl?: string; website?: string | null;
  employeeCount?: number; tagline?: string;
  locations?: Array<{ parsed?: { text?: string } }>;
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
  find_people_at_company: 0.14,
  find_employees_at_company: 0.1,
  read_recent_posts: 0.02,
  record_contact: 0,
  record_no_contact: 0,
};

/** What the agent committed to. `null` name means it committed to finding nobody. */
export interface EnrichOutcome {
  found: boolean;
  contact: EnrichResult | null;
  /** Why nobody, when found is false. */
  reason: string;
}

export interface EnrichToolContext {
  jobId: string;
  /** Everything the tools have returned this run; record_contact cites against it. */
  transcript: { text: string };
  onFinish: (o: EnrichOutcome) => void;
  /** Returns false when the run has spent its budget. */
  charge: (tool: string) => boolean;
}

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
      recordActorCall(COMPANY_SEARCH, rows.length);
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
        // Full for the same reason as the other source, confirmed on the same
        // three people at Adyen once the plan cap lifted. Short returns an
        // opaque member id in `linkedinUrl` (/in/ACwAAAWDOpsB...) and About
        // text where a headline belongs; Full returns /in/modamman and "Head of
        // Card Network & Product Partnerships at Adyen". Note this actor's own
        // default is already 'Full' — we were overriding it with the broken one.
        //
        // $0.10 per search page + $0.004/profile = $0.14 at ten, up from $0.10.
        profileScraperMode: 'Full',
        currentCompanies: [companyLinkedinUrl],
        ...(jobTitles?.length ? { currentJobTitles: jobTitles } : {}),
        maxItems: 10,
      }, 10, PROFILE_FIELDS)) as RawProfile[];
      recordSpend(PROFILE_SEARCH, TOOL_COST_USD['find_people_at_company']!, ctx.jobId);
      recordActorCall(PROFILE_SEARCH, rows.length);

      if (!rows.length) {
        // The model cannot tell an outage from a real empty result, and it does
        // not need to — the right move is the same either way. But when we can
        // measure that a source is degraded, saying so is information it
        // otherwise has no way to obtain.
        const degraded = actorHealth().find((h) => h.actor === PROFILE_SEARCH)?.degraded;
        return remember(
          'No profiles returned by this source. ' +
          (degraded
            ? 'This source has returned nothing on every recent call, so it is probably ' +
              'having trouble rather than telling you the company is empty. '
            : 'That can mean the company has nobody matching, or that this source is ' +
              'struggling — one call cannot tell you which. ') +
          'find_employees_at_company reads the same data from an independent source; ' +
          'if you have not tried it for this company, it is worth one call.',
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
        // FULL, NOT SHORT, and the difference is not detail — it is whether the
        // answer is usable at all. Measured on the same company: Short returns
        // no `headline`, no `publicIdentifier`, and an OPAQUE MEMBER ID in
        // `linkedinUrl` (/in/ACwAAAHBqUgB...) which does not resolve. Full
        // returns /in/rachitchaudhary, a headline, and LinkedIn's #hiring flag.
        // We were paying for a source, getting a dead link and no job title,
        // and reading that as the source being weak.
        //
        // $0.02 start + $0.008/profile = $0.10 at ten, up from $0.05 — the same
        // price as find_people_at_company, which currently returns nothing.
        profileScraperMode: 'Full ($8 per 1k)',
        companies: [companyLinkedinUrl],
        ...(jobTitles?.length ? { jobTitles } : {}),
        maxItems: 10,
      }, 10, PROFILE_FIELDS)) as RawProfile[];
      recordSpend(COMPANY_EMPLOYEES, TOOL_COST_USD['find_employees_at_company']!, ctx.jobId);
      recordActorCall(COMPANY_EMPLOYEES, rows.length);

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
      recordActorCall(PROFILE_POSTS, rows.length);
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

      // A dead link is not a smaller answer, it is no answer: the point of the
      // run is that a human can open the profile and write to them. The model
      // cannot check this from inside its loop — an opaque member id looks
      // exactly like a URL — so it is enforced here and explained.
      if (!isResolvableProfileUrl(input.profileUrl)) {
        return `REFUSED: "${input.profileUrl}" is not a profile link anyone can open. ` +
               `A LinkedIn member id (/in/ACw...) is not a usable URL. Find this person ` +
               `again with find_employees_at_company, which returns real profile URLs, ` +
               `or commit a different candidate whose link opens.`;
      }

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
      ctx.onFinish({ found: true, contact: result, reason: '' });
      return 'Recorded. You are done — reply with a one-line summary and call no more tools.';
    },
  });

  /**
   * Committing to "nobody" is an ANSWER, not a failure to answer.
   *
   * The runner previously inferred this from free text and labelled it
   * `no_block`, i.e. failure — while the prompt explicitly told the model not
   * to call record_contact when it found nobody. Correct behaviour scored as
   * failure, the same class of error as a step ceiling being reported as "no
   * usable answer".
   *
   * Making it an explicit commitment also makes it scoreable: on a case whose
   * correct answer is that no contact exists, calling this is the pass
   * condition and committing a person is the failure.
   */
  const record_no_contact = createTool({
    id: 'record_no_contact',
    description:
      'Finish by committing that no suitable contact could be found. Use this when you have ' +
      'searched properly — including the second source — and there is genuinely nobody to ' +
      'approach, or the sources could not answer. This is a valid answer, not a failure. ' +
      'Never guess a person instead of calling this.',
    inputSchema: z.object({
      reason: z.string().describe(
        'What you tried and why you concluded nobody is reachable. Say plainly if a source ' +
        'returned nothing rather than the company having nobody.',
      ),
    }),
    execute: async ({ reason }) => {
      ctx.onFinish({ found: false, contact: null, reason });
      return 'Recorded that no contact was found. You are done — reply with one line and call no more tools.';
    },
  });

  return {
    resolve_company,
    find_people_at_company,
    find_employees_at_company,
    read_recent_posts,
    record_contact,
    record_no_contact,
  };
}

/**
 * The tools the enrich agent may use.
 *
 * Narrow by design. Each wraps one Apify actor with a fixed actor name and a
 * small argument schema, so the model chooses *what to find out*, never *what
 * to spend*. Three consequences worth keeping:
 *
 *   - a hallucinated actor name is impossible; only these three names exist
 *   - cost per call is known up front, so the loop can refuse before spending
 *   - the schema stays small enough for a 3B model to use, which is the point
 *     of the comparison
 */
import { recordContact, recordSpend } from '../store/db.js';
import { runActorViaMcp } from './mcp.js';
import type { ToolImpl } from './agent.js';

const PROFILE_SEARCH = 'harvestapi/linkedin-profile-search';
const PROFILE_POSTS = 'harvestapi/linkedin-profile-posts';

interface ShortProfile {
  firstName?: string; lastName?: string; headline?: string;
  linkedinUrl?: string; publicIdentifier?: string;
  location?: { linkedinText?: string };
}

interface Post { content?: string; postedAt?: string; text?: string }

export interface EnrichResult {
  name: string;
  title: string;
  profileUrl: string;
  observation: string;
  reasoning: string;
}

/**
 * @param jobId       the posting being enriched, for attributing spend
 * @param onFinish    called when the agent commits to an answer
 */
export function enrichTools(jobId: string, onFinish: (r: EnrichResult) => void): ToolImpl[] {
  return [
    {
      name: 'find_people_at_company',
      description:
        'Find people at a company on LinkedIn, filtered by job title. Use this when the ' +
        'job posting does not name a hiring manager, or names a recruiter and you want the ' +
        'person who actually owns the team. Returns names, headlines and profile URLs.',
      costUsd: 0.1,
      parameters: {
        type: 'object',
        properties: {
          companyLinkedinUrl: {
            type: 'string',
            description: 'Full LinkedIn company URL, e.g. https://www.linkedin.com/company/trustoo',
          },
          jobTitles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Titles to look for, e.g. ["Head of Product", "Product Director", "CTO"]',
          },
        },
        required: ['companyLinkedinUrl'],
      },
      async run(args) {
        const rows = (await runActorViaMcp(PROFILE_SEARCH, {
          profileScraperMode: 'Short',
          currentCompanies: [args['companyLinkedinUrl']],
          ...(Array.isArray(args['jobTitles']) && args['jobTitles'].length
            ? { currentJobTitles: args['jobTitles'] }
            : {}),
          maxItems: 10,
        }, 10)) as ShortProfile[];

        recordSpend(PROFILE_SEARCH, 0.1, jobId);
        if (!rows.length) return 'No profiles matched. Try broader job titles, or fewer filters.';

        return rows
          .map((p) => {
            const name = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || '(no name)';
            return `${name} — ${p.headline ?? 'no headline'}\n  ${p.linkedinUrl ?? ''}` +
                   `${p.location?.linkedinText ? `\n  ${p.location.linkedinText}` : ''}`;
          })
          .join('\n\n');
      },
    },

    {
      name: 'read_recent_posts',
      description:
        'Read what a person has posted on LinkedIn recently. Use this to find one specific, ' +
        'true observation to open a message with. Someone who has posted recently is also far ' +
        'likelier to read a connection request.',
      costUsd: 0.02,
      parameters: {
        type: 'object',
        properties: {
          profileUrl: { type: 'string', description: 'Their LinkedIn profile URL' },
        },
        required: ['profileUrl'],
      },
      async run(args) {
        const rows = (await runActorViaMcp(PROFILE_POSTS, {
          targetUrls: [args['profileUrl']],
          maxPosts: 5,
          postedLimit: 'year',
        }, 5)) as Post[];

        recordSpend(PROFILE_POSTS, 0.02, jobId);
        if (!rows.length) return 'No recent posts. This person is not active on LinkedIn.';

        return rows
          .map((p, i) => `[${i + 1}] ${p.postedAt ?? ''}\n${(p.content ?? p.text ?? '').slice(0, 600)}`)
          .join('\n\n');
      },
    },

    {
      name: 'record_contact',
      description:
        'Commit to an answer and finish. Call this once you have identified the best person ' +
        'to approach. Do not call it with a guess — if you could not find anyone, say so in ' +
        'your reply instead of calling this tool.',
      costUsd: 0,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          title: { type: 'string', description: 'Their role, as their profile states it' },
          profileUrl: { type: 'string' },
          observation: {
            type: 'string',
            description:
              'One specific, true thing about them or the company that a message could open ' +
              'with. Must come from something you actually read, not from the job title.',
          },
          reasoning: {
            type: 'string',
            description: 'Why this person rather than the others you saw. One or two sentences.',
          },
        },
        required: ['name', 'profileUrl', 'reasoning'],
      },
      async run(args) {
        const result: EnrichResult = {
          name: String(args['name'] ?? ''),
          title: String(args['title'] ?? ''),
          profileUrl: String(args['profileUrl'] ?? ''),
          observation: String(args['observation'] ?? ''),
          reasoning: String(args['reasoning'] ?? ''),
        };
        recordContact(jobId, result.name, result.title || null, result.profileUrl || null,
                      'enrich-agent', result.observation || null);
        onFinish(result);
        return 'Recorded. You are done — reply with a one-line summary and call no more tools.';
      },
    },
  ];
}

/**
 * The tools the enrich agent may use.
 *
 * Narrow by design. Each wraps one Apify actor with a fixed actor name and a
 * small argument schema, so the model chooses *what to find out*, never *what
 * to spend*. A hallucinated actor name is impossible, cost per call is known
 * before it happens, and the schema stays small enough for a 3B model — which
 * is the point of the provider comparison.
 *
 * ON JUDGEMENT AND HOW IT IS CHECKED
 *
 * Everything judgemental in this system happens here: is this person the
 * hiring manager or a recruiter, which of ten search results owns the work,
 * is this post a usable observation or noise, which of three companies called
 * "Skydreams" is the right one.
 *
 * None of that can be verified by reading the model's own `reasoning` field —
 * that is the model marking its own homework. So the observation it commits to
 * must be CITED: `observationSource` has to be text that actually appears in
 * something a tool returned this run, and `record_contact` refuses when it
 * does not. That turns "trust the judgement" into "check the evidence", which
 * is the same discipline the drafting corpus already enforces.
 */
import { recordContact, recordSpend } from '../store/db.js';
import { runActorViaMcp } from './mcp.js';
import type { ToolImpl } from './agent.js';

const COMPANY_SEARCH = 'harvestapi/linkedin-company';
const PROFILE_SEARCH = 'harvestapi/linkedin-profile-search';
const PROFILE_POSTS = 'harvestapi/linkedin-profile-posts';

interface CompanyHit {
  name?: string; linkedinUrl?: string; website?: string | null;
  employeeCount?: number; tagline?: string; description?: string;
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
  /** Verbatim text from a tool result that supports the observation. */
  observationSource: string;
  reasoning: string;
}

/** Loose containment: whitespace and case must not decide a grounding check. */
const flat = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function enrichTools(
  jobId: string,
  onFinish: (r: EnrichResult) => void,
): ToolImpl[] {
  /**
   * Everything every tool has returned this run. `record_contact` checks its
   * citation against this, so the agent cannot commit to an observation it
   * did not read.
   */
  let transcript = '';
  const remember = (s: string) => { transcript += `\n${s}`; return s; };

  return [
    {
      name: 'resolve_company',
      description:
        'Find a company on LinkedIn by name, and get its LinkedIn URL. You need this before ' +
        'you can search for people, unless the task already gives you a company LinkedIn URL. ' +
        'Returns several candidates when the name is ambiguous — pick using the website, size ' +
        'and location given in the task, and say which you picked and why.',
      costUsd: 0.005,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The company name as the job posting gives it' },
        },
        required: ['name'],
      },
      async run(args) {
        const rows = (await runActorViaMcp(
          COMPANY_SEARCH, { searches: [String(args['name'] ?? '')] }, 5,
        )) as CompanyHit[];
        recordSpend(COMPANY_SEARCH, 0.005, jobId);

        if (!rows.length) return remember('No company matched that name on LinkedIn.');
        return remember(rows.map((c) =>
          [`${c.name ?? '(no name)'} — ${c.linkedinUrl ?? 'no url'}`,
           c.website ? `  website: ${c.website}` : null,
           c.employeeCount ? `  employees: ${c.employeeCount}` : null,
           c.locations?.[0]?.parsed?.text ? `  location: ${c.locations[0].parsed.text}` : null,
           c.tagline ? `  tagline: ${c.tagline}` : null,
          ].filter(Boolean).join('\n')).join('\n\n'));
      },
    },

    {
      name: 'find_people_at_company',
      description:
        'Find people at a company on LinkedIn, filtered by job title. Use when the posting ' +
        'does not name a hiring manager, or names a recruiter and you want the person who ' +
        'owns the team. Needs a LinkedIn company URL — call resolve_company first if you ' +
        'do not have one.',
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
            description: 'Titles to look for, e.g. ["Head of Product", "Product Director", "Founder"]',
          },
        },
        required: ['companyLinkedinUrl'],
      },
      async run(args) {
        const titles = Array.isArray(args['jobTitles']) ? args['jobTitles'] : [];
        const rows = (await runActorViaMcp(PROFILE_SEARCH, {
          profileScraperMode: 'Short',
          currentCompanies: [args['companyLinkedinUrl']],
          ...(titles.length ? { currentJobTitles: titles } : {}),
          maxItems: 10,
        }, 10)) as ShortProfile[];
        recordSpend(PROFILE_SEARCH, 0.1, jobId);

        if (!rows.length) {
          return remember('No profiles matched. Try broader titles, or drop the title filter.');
        }
        return remember(rows.map((p) => {
          const name = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || '(no name)';
          return `${name} — ${p.headline ?? 'no headline'}\n  ${p.linkedinUrl ?? ''}` +
                 `${p.location?.linkedinText ? `\n  ${p.location.linkedinText}` : ''}`;
        }).join('\n\n'));
      },
    },

    {
      name: 'read_recent_posts',
      description:
        'Read what a person has posted on LinkedIn recently. This is where an observation ' +
        'comes from. Someone who posts is also far likelier to accept a connection request.',
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
          targetUrls: [args['profileUrl']], maxPosts: 5, postedLimit: 'year',
        }, 5)) as Post[];
        recordSpend(PROFILE_POSTS, 0.02, jobId);

        if (!rows.length) {
          return remember('No recent posts. This person is not active on LinkedIn.');
        }
        return remember(rows.map((p, i) =>
          `[${i + 1}] ${p.postedAt ?? ''}\n${(p.content ?? p.text ?? '').slice(0, 600)}`,
        ).join('\n\n'));
      },
    },

    {
      name: 'record_contact',
      description:
        'Commit to an answer and finish. Call once you have identified who to approach. ' +
        'If you have an observation you MUST quote the exact text you took it from in ' +
        'observationSource — this is checked against what the tools actually returned, and ' +
        'the call is refused if the quote is not found. If you have no real observation, ' +
        'leave both observation fields empty rather than inventing one.',
      costUsd: 0,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          title: { type: 'string', description: 'Their role, as their profile states it' },
          profileUrl: { type: 'string' },
          observation: {
            type: 'string',
            description: 'One specific true thing a message could open with. May be empty.',
          },
          observationSource: {
            type: 'string',
            description:
              'VERBATIM text, copied from a tool result, that the observation rests on. ' +
              'At least 20 characters. Required whenever observation is non-empty.',
          },
          reasoning: {
            type: 'string',
            description: 'Why this person rather than the others you saw. One or two sentences.',
          },
        },
        required: ['name', 'profileUrl', 'reasoning'],
      },
      async run(args) {
        const observation = String(args['observation'] ?? '').trim();
        const source = String(args['observationSource'] ?? '').trim();

        // Mechanical grounding. A model that fabricates an observation for a
        // real human is the worst failure this system can produce, so it is
        // checked rather than asked for.
        if (observation) {
          if (source.length < 20) {
            return 'REFUSED: an observation needs observationSource — at least 20 characters ' +
                   'copied verbatim from a tool result. Quote what you actually read, or ' +
                   'call again with both observation fields empty.';
          }
          if (!flat(transcript).includes(flat(source))) {
            return 'REFUSED: that observationSource does not appear in anything the tools ' +
                   'returned this run. Do not paraphrase — copy the text exactly, or call ' +
                   'again with both observation fields empty.';
          }
        }

        const result: EnrichResult = {
          name: String(args['name'] ?? ''),
          title: String(args['title'] ?? ''),
          profileUrl: String(args['profileUrl'] ?? ''),
          observation,
          observationSource: source,
          reasoning: String(args['reasoning'] ?? ''),
        };
        recordContact(jobId, result.name, result.title || null, result.profileUrl || null,
                      'enrich-agent', observation || null);
        onFinish(result);
        return 'Recorded. You are done — reply with a one-line summary and call no more tools.';
      },
    },
  ];
}

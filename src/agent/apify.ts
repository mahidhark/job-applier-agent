/**
 * Apify over MCP.
 *
 * The agent reaches Apify through Apify's own MCP server rather than a
 * hand-rolled REST client, so adding a capability is adding a tool wrapper
 * rather than an adapter. The scheduled discovery poll still uses REST
 * (src/sources/apify/client.ts) because a cron process should not carry an
 * MCP session just to fetch a job list — MCP earns its place here, in the
 * agentic step, and nowhere else.
 *
 * One connection is shared across a poll pass and closed at the end; opening a
 * session per job would cost more in handshakes than the calls themselves.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { APIFY_TOKEN } from '../config.js';

const ENDPOINT = process.env.APIFY_MCP_URL ?? 'https://mcp.apify.com/';

let client: Client | null = null;

export async function apifyMcp(): Promise<Client> {
  if (client) return client;
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set — the enrich agent needs it');

  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${APIFY_TOKEN}` } },
  });
  const c = new Client({ name: 'job-applier-agent', version: '0.1.0' }, { capabilities: {} });
  // The SDK declares Transport.sessionId as `string | undefined` while the
  // interface requires `string`, which only conflicts under
  // exactOptionalPropertyTypes. That flag catches real bugs elsewhere in this
  // repo, so it stays on and the third-party mismatch is narrowed to here.
  await c.connect(transport as unknown as Parameters<Client['connect']>[0]);
  client = c;
  return c;
}

export async function closeMcp(): Promise<void> {
  await client?.close();
  client = null;
}

/** Every text block from an MCP tool result, kept separate. */
function textBlocks(result: unknown): string[] {
  const blocks = (result as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  return blocks.filter((b) => b.type === 'text').map((b) => (b.text ?? '').trim()).filter(Boolean);
}

/** All blocks joined, for error messages only. */
const textOf = (result: unknown): string => textBlocks(result).join('\n');

/**
 * Pull an item array out of one text block.
 *
 * Servers wrap results inconsistently — a bare array, `{items:[...]}`, or that
 * JSON nested in a `text` field. Returns null rather than a guess, so callers
 * raise instead of proceeding on a false emptiness.
 */
function parseItems(raw: string): unknown[] | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v)) return v;
    const o = v as { items?: unknown; text?: unknown };
    if (Array.isArray(o.items)) return o.items;
    if (typeof o.text === 'string') return parseItems(o.text);
    return null;
  } catch {
    return null;
  }
}

/**
 * Why a run produced nothing, when the run itself says so.
 *
 * Apify returns `status: "SUCCEEDED"` with zero items and the real reason in
 * `statusMessage` — for example `"free user run limit exceeded"`. Read as a
 * plain empty result, that is a lie the whole way up the stack: the tool tells
 * the model "no profiles at this company", the model reasonably concludes
 * nobody is there, and a quota problem is recorded as a fact about a business.
 *
 * That happened. `linkedin-profile-search` returned zero rows for every
 * company including Booking.com for a day; it was diagnosed as an upstream
 * outage and a health-tracking table was built to infer it from repeated
 * emptiness. The answer was in `statusMessage` on every single response.
 *
 * These messages are about the ACCOUNT, not the query. A different search will
 * not fix one, so the model must not be handed it as something to work around
 * — it is raised, and a human is told.
 */
const BLOCKING_STATUS = /run limit|usage limit|quota|exceeded|insufficient|payment|not enough|unauthorized|forbidden/i;

interface RunRecord {
  status?: string;
  statusMessage?: string;
  storages?: { datasets?: { default?: { id?: string; itemCount?: number } } };
}

export class ActorBlockedError extends Error {
  override readonly name = 'ActorBlockedError';
  constructor(readonly actor: string, readonly statusMessage: string) {
    super(`${actor} produced nothing: "${statusMessage}". This is an account or quota ` +
          `problem, not an empty search — no query will work until it is resolved.`);
  }
}

/** The run's own explanation, when it produced no rows and gave one. */
function blockingMessage(raw: string): string | null {
  try {
    const o = JSON.parse(raw) as RunRecord;
    const msg = o.statusMessage?.trim();
    if (!msg) return null;
    const count = o.storages?.datasets?.default?.itemCount;
    if (count) return null; // it produced rows; whatever it said, it worked
    return BLOCKING_STATUS.test(msg) ? msg : null;
  } catch {
    return null;
  }
}

/** Dataset id, wherever the response happens to put it. */
function findDatasetId(raw: string): string | null {
  try {
    const o = JSON.parse(raw) as {
      datasetId?: string;
      storages?: { datasets?: { default?: { id?: string } } };
    };
    return o.datasetId ?? o.storages?.datasets?.default?.id ?? null;
  } catch {
    return /datasetId["':\s]+([A-Za-z0-9_-]+)/.exec(raw)?.[1] ?? null;
  }
}

/**
 * Run one Apify actor and return its dataset rows.
 *
 * Deliberately not exposed to the agent as a tool. Letting a model choose an
 * arbitrary actor means letting it choose an arbitrary bill, and the
 * `call-actor` schema is large enough to confuse a small model on its own.
 *
 * Three response shapes have been observed in practice, which is why this
 * reads defensively rather than assuming one:
 *
 *   - items inline in a block, alongside a datasetId
 *   - run metadata only, with the dataset at storages.datasets.default.id
 *   - both, as SEPARATE content blocks
 *
 * The last one broke an earlier version: it joined every block with a newline
 * and then tried to JSON.parse the concatenation, which of course failed, and
 * the fallback returned a single {text} row. `resolve_company` then reported
 * "no company matched" six times in a row while the answer sat in a block it
 * had already been handed.
 */
export async function runActorViaMcp(
  actor: string,
  input: Record<string, unknown>,
  maxItems = 25,
  /**
   * Comma-separated field projection, e.g. `firstName,linkedinUrl,headline`.
   *
   * Needed because a full LinkedIn profile is 66k-109k characters — measured,
   * with one at 109,425 — and ten of them is most of a megabyte per call. None
   * of it reaches the model (the tools render before returning), but all of it
   * has to cross the transport and be parsed.
   *
   * Passing this SKIPS the inline-items shortcut below, because `call-actor`
   * returns whole records and only `get-dataset-items` can project. That costs
   * one extra round trip and saves three orders of magnitude of payload.
   */
  fields?: string,
): Promise<unknown[]> {
  const c = await apifyMcp();
  const run = await c.callTool({
    name: 'call-actor',
    arguments: { actor, input, waitSecs: 45 },
  });

  const blocks = textBlocks(run);

  if (!fields) {
    for (const b of blocks) {
      const items = parseItems(b);
      if (items?.length) return items.slice(0, maxItems);
    }
  }

  for (const b of blocks) {
    const id = findDatasetId(b);
    if (!id) continue;
    const got = await c.callTool({
      name: 'get-dataset-items',
      arguments: { datasetId: id, limit: maxItems, clean: true, ...(fields ? { fields } : {}) },
    });
    for (const gb of textBlocks(got)) {
      const items = parseItems(gb);
      if (items?.length) return items.slice(0, maxItems);
      // Zero items is where the lie lives: ask the run record why before
      // agreeing that the company has nobody.
      if (items) {
        for (const b of blocks) {
          const msg = blockingMessage(b);
          if (msg) throw new ActorBlockedError(actor, msg);
        }
        return [];
      }
    }
  }

  // A projection that matched nothing still leaves the inline records readable,
  // and a large answer beats no answer.
  if (fields) {
    for (const b of blocks) {
      const items = parseItems(b);
      if (items?.length) return items.slice(0, maxItems);
    }
  }

  // Before calling it unreadable, check whether the run explained itself. An
  // account limit is not an empty search and must never be reported as one.
  for (const b of blocks) {
    const msg = blockingMessage(b);
    if (msg) throw new ActorBlockedError(actor, msg);
  }

  // An empty result is a real answer; an unreadable one is not. Raising here
  // means the agent is told the tool failed rather than told there is nothing.
  throw new Error(
    `${actor}: could not read items from ${blocks.length} response block(s): ` +
    `${textOf(run).slice(0, 200)}`,
  );
}

/** Exposed for tests only: the run-record reading that has been wrong twice. */
export const __test = { blockingMessage };

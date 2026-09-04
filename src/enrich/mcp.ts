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
): Promise<unknown[]> {
  const c = await apifyMcp();
  const run = await c.callTool({
    name: 'call-actor',
    arguments: { actor, input, waitSecs: 45 },
  });

  const blocks = textBlocks(run);

  for (const b of blocks) {
    const items = parseItems(b);
    if (items?.length) return items.slice(0, maxItems);
  }

  for (const b of blocks) {
    const id = findDatasetId(b);
    if (!id) continue;
    const got = await c.callTool({
      name: 'get-dataset-items',
      arguments: { datasetId: id, limit: maxItems, clean: true },
    });
    for (const gb of textBlocks(got)) {
      const items = parseItems(gb);
      if (items) return items.slice(0, maxItems);
    }
  }

  // An empty result is a real answer; an unreadable one is not. Raising here
  // means the agent is told the tool failed rather than told there is nothing.
  throw new Error(
    `${actor}: could not read items from ${blocks.length} response block(s): ` +
    `${textOf(run).slice(0, 200)}`,
  );
}

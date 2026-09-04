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

/** Text content from an MCP tool result, which arrives as content blocks. */
function textOf(result: unknown): string {
  const blocks = (result as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
}

/**
 * Run one Apify actor and return its dataset rows.
 *
 * Deliberately not exposed to the agent as a tool. Letting a model choose an
 * arbitrary actor means letting it choose an arbitrary bill, and the tool
 * schema for `call-actor` is large enough to confuse a small model on its own.
 * The narrow wrappers in tools.ts are what the agent sees.
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

  const match = /datasetId[=:"\s]+([A-Za-z0-9_-]+)/.exec(textOf(run));
  if (!match?.[1]) throw new Error(`no datasetId in actor result for ${actor}`);

  const items = await c.callTool({
    name: 'get-dataset-items',
    arguments: { datasetId: match[1], limit: maxItems, clean: true },
  });

  const text = textOf(items);
  try {
    const parsed = JSON.parse(text) as { items?: unknown[] };
    return parsed.items ?? (Array.isArray(parsed) ? parsed : []);
  } catch {
    // Some MCP servers pre-render results as prose. Hand it back as one row so
    // the agent still sees something rather than an empty list.
    return text ? [{ text }] : [];
  }
}

/**
 * Apify's MCP server, as Mastra tools.
 *
 * The agent gets Apify's own tools rather than wrappers I wrote, which is the
 * point: it can discover and call actors at runtime instead of being limited
 * to a fixed set someone anticipated.
 *
 * That freedom has a bill attached. `call-actor` will run whatever actor the
 * model names, at whatever that actor charges, so the spend guard lives in the
 * run loop (src/agent/run.ts) rather than in the tool definitions — there is
 * no per-tool cost to declare when the tool is "call anything".
 */
import { MCPClient } from '@mastra/mcp';
import { APIFY_TOKEN } from '../config.js';

const ENDPOINT = process.env.APIFY_MCP_URL ?? 'https://mcp.apify.com/';

let client: MCPClient | null = null;

export function apifyMcpClient(): MCPClient {
  if (client) return client;
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set — the agent needs it for Apify MCP');

  client = new MCPClient({
    id: 'apify',
    servers: {
      apify: {
        url: new URL(ENDPOINT),
        requestInit: { headers: { Authorization: `Bearer ${APIFY_TOKEN}` } },
      },
    },
  });
  return client;
}

/**
 * Every tool the Apify MCP server exposes, namespaced, in Mastra's shape.
 *
 * `listTools()` flattens across servers with an `apify_` prefix. That prefix
 * matters for a small model: it has to reproduce the name exactly, and a long
 * namespaced name is one more thing to get wrong. The run records tool-name
 * errors for exactly this reason.
 */
export async function apifyTools(): Promise<Record<string, unknown>> {
  return (await apifyMcpClient().listTools()) as Record<string, unknown>;
}

export async function closeMcp(): Promise<void> {
  await client?.disconnect();
  client = null;
}

/**
 * MCP servers, as Mastra tools.
 *
 * Every connection comes from config/connections.json, so adding a server is a
 * config change and credentials never live in the repo. A server whose token
 * is missing is skipped with a warning rather than throwing — one unconfigured
 * integration should not stop the others.
 */
import { MCPClient } from '@mastra/mcp';
import { resolveConnections, type ConnectionStatus } from './connections.js';

let client: MCPClient | null = null;
let lastStatus: ConnectionStatus[] = [];

export function connectionStatus(): ConnectionStatus[] {
  return lastStatus;
}

export function mcpClient(profile?: string): MCPClient {
  if (client) return client;

  const { ready, status } = resolveConnections(profile);
  lastStatus = status;

  for (const s of status) {
    if (!s.ready && s.enabled) console.warn(`  ! mcp ${s.name}: ${s.reason}`);
  }
  if (!ready.length) {
    throw new Error(
      'no MCP server is reachable. ' +
      status.map((s) => `${s.name}: ${s.reason}`).join('; '),
    );
  }

  const servers: Record<string, { url: URL; requestInit: { headers: Record<string, string> } }> = {};
  for (const s of ready) servers[s.name] = { url: s.url, requestInit: { headers: s.headers } };

  client = new MCPClient({ id: 'job-applier-agent', servers: servers as never });
  return client;
}

/**
 * Every tool the connected servers expose, namespaced by server.
 *
 * Fetched at runtime rather than declared, which is the point — the agent gets
 * whatever the servers currently offer. What they offer is itself configurable
 * through the tool profile, because a large generic surface and a small typed
 * one are very different problems for a small model.
 */
export async function mcpTools(profile?: string): Promise<Record<string, unknown>> {
  return (await mcpClient(profile).listTools()) as Record<string, unknown>;
}

export async function closeMcp(): Promise<void> {
  await client?.disconnect();
  client = null;
}

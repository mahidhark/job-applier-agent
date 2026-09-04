/**
 * MCP connections and their credentials.
 *
 * config/connections.json is committed to a public repo, so it names the
 * environment variable a server needs and never the value. Resolution happens
 * here, at startup, and a missing token disables that server with a warning
 * rather than throwing halfway through a run.
 *
 * The tool profile is part of the connection because for Apify it is part of
 * the URL. That is not incidental plumbing: the size and shape of the tool
 * surface is the most likely explanation for a small model failing to hold a
 * goal, so it has to be switchable without touching code.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../config.js';

export interface AuthSpec {
  type: 'bearer' | 'query' | 'none';
  /** NAME of the env var holding the credential. Never the credential. */
  tokenEnv?: string;
  /** For `query` auth: the parameter name, e.g. "token". */
  param?: string;
}

export interface ServerSpec {
  enabled: boolean;
  kind: 'http';
  url: string;
  auth: AuthSpec;
  toolProfile?: string;
}

export interface ToolProfile {
  description: string;
  tools: string[];
}

export interface ConnectionsFile {
  servers: Record<string, ServerSpec>;
  toolProfiles: Record<string, ToolProfile>;
}

export interface ResolvedServer {
  name: string;
  /** Full URL including any tools= selection and query-auth parameter. */
  url: URL;
  headers: Record<string, string>;
  toolProfile: string;
  tools: string[];
}

export interface ConnectionStatus {
  name: string;
  enabled: boolean;
  ready: boolean;
  reason: string;
  toolProfile: string;
  toolCount: number;
}

/**
 * Keys beginning with `$` are documentation, not data.
 *
 * JSON has no comments and this file is meant to be read by whoever edits it,
 * so `$comment` and `$note` carry the explanation. They must be stripped
 * before anything iterates, or a comment gets treated as a server.
 */
const withoutDocKeys = <T>(o: Record<string, unknown>): Record<string, T> =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !k.startsWith('$'))) as Record<string, T>;

function read(dir: string): ConnectionsFile {
  const path = join(dir, 'connections.json');
  if (!existsSync(path)) throw new Error(`missing connections config at ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    servers?: Record<string, unknown>;
    toolProfiles?: Record<string, unknown>;
  };
  if (!raw.servers) throw new Error('connections.json has no "servers" section');
  if (!raw.toolProfiles) throw new Error('connections.json has no "toolProfiles" section');

  return {
    servers: withoutDocKeys<ServerSpec>(raw.servers),
    toolProfiles: withoutDocKeys<ToolProfile>(raw.toolProfiles),
  };
}

/**
 * @param overrideProfile forces every server onto one profile, so the same run
 *                        can be repeated across tool surfaces from the CLI.
 */
export function resolveConnections(
  overrideProfile?: string,
  dir = CONFIG_DIR,
): { ready: ResolvedServer[]; status: ConnectionStatus[] } {
  const file = read(dir);
  const ready: ResolvedServer[] = [];
  const status: ConnectionStatus[] = [];

  for (const [name, spec] of Object.entries(file.servers)) {
    const profileName = overrideProfile ?? spec.toolProfile ?? 'all';
    const profile = file.toolProfiles[profileName];

    if (!spec.enabled) {
      status.push({ name, enabled: false, ready: false, reason: 'disabled in config',
                    toolProfile: profileName, toolCount: 0 });
      continue;
    }
    if (!profile) {
      status.push({ name, enabled: true, ready: false,
                    reason: `unknown toolProfile "${profileName}"`,
                    toolProfile: profileName, toolCount: 0 });
      continue;
    }

    const token = spec.auth.tokenEnv ? process.env[spec.auth.tokenEnv] : undefined;
    if (spec.auth.type !== 'none' && !token) {
      status.push({ name, enabled: true, ready: false,
                    reason: `${spec.auth.tokenEnv} is not set`,
                    toolProfile: profileName, toolCount: profile.tools.length });
      continue;
    }

    const url = new URL(spec.url);
    if (profile.tools.length) url.searchParams.set('tools', profile.tools.join(','));

    const headers: Record<string, string> = {};
    if (spec.auth.type === 'bearer' && token) headers['Authorization'] = `Bearer ${token}`;
    if (spec.auth.type === 'query' && token) url.searchParams.set(spec.auth.param ?? 'token', token);

    ready.push({ name, url, headers, toolProfile: profileName, tools: profile.tools });
    status.push({ name, enabled: true, ready: true, reason: 'ready',
                  toolProfile: profileName, toolCount: profile.tools.length });
  }

  return { ready, status };
}

export function listToolProfiles(dir = CONFIG_DIR): Record<string, ToolProfile> {
  return read(dir).toolProfiles;
}

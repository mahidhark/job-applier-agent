/**
 * Minimal Apify REST client.
 *
 * The MCP server is convenient interactively but this process runs unattended,
 * so it talks to the REST API directly with a token. Only two calls are needed:
 * run an actor to completion, and read its dataset.
 */
import { APIFY_TOKEN } from '../../config.js';

const BASE = 'https://api.apify.com/v2';

export interface RunResult {
  datasetId: string;
  status: string;
  runId: string;
}

/** Actor names are `user/name`; the REST path wants `user~name`. */
const toPath = (actor: string) => actor.replace('/', '~');

export async function runActor(
  actor: string,
  input: Record<string, unknown>,
  { timeoutSecs = 300, memoryMbytes = 1024 } = {},
): Promise<RunResult> {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set');

  const url =
    `${BASE}/acts/${toPath(actor)}/run-sync?token=${APIFY_TOKEN}` +
    `&timeout=${timeoutSecs}&memory=${memoryMbytes}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`apify ${actor}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { data?: { defaultDatasetId?: string; status?: string; id?: string } };
  const datasetId = body.data?.defaultDatasetId;
  if (!datasetId) throw new Error(`apify ${actor}: run returned no dataset`);
  return { datasetId, status: body.data?.status ?? 'UNKNOWN', runId: body.data?.id ?? '' };
}

export async function datasetItems<T>(datasetId: string, limit = 1000): Promise<T[]> {
  const res = await fetch(
    `${BASE}/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`apify dataset ${datasetId}: HTTP ${res.status}`);
  return (await res.json()) as T[];
}

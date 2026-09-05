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

/**
 * Run an actor and return its dataset rows.
 *
 * `run-sync-get-dataset-items`, NOT `run-sync`. The latter returns the actor's
 * OUTPUT key-value record, which this actor does not write, so the body came
 * back empty and `res.json()` threw "Unexpected end of JSON input" on every
 * call. Between that and a rejected `datePosted` value, paid discovery had
 * never once succeeded: 3,088 postings in the store, every one of them from
 * the two free ATS boards.
 *
 * One call rather than run-then-read, because the endpoint exists precisely to
 * avoid managing a dataset id for a job that is already finished.
 */
export async function runActorForItems<T>(
  actor: string,
  input: Record<string, unknown>,
  { timeoutSecs = 300, memoryMbytes = 1024, limit = 1000 } = {},
): Promise<T[]> {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set');

  const url =
    `${BASE}/acts/${toPath(actor)}/run-sync-get-dataset-items?token=${APIFY_TOKEN}` +
    `&timeout=${timeoutSecs}&memory=${memoryMbytes}&clean=true&limit=${limit}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`apify ${actor}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  // An empty body is not an empty result — it means the response was not what
  // this code expects, and silently returning [] is how the previous shape
  // hid a total outage behind "0 new".
  const text = await res.text();
  if (!text.trim()) throw new Error(`apify ${actor}: empty response body`);
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`apify ${actor}: expected an array of items, got ${typeof parsed}`);
  }
  return parsed as T[];
}

export async function datasetItems<T>(datasetId: string, limit = 1000): Promise<T[]> {
  const res = await fetch(
    `${BASE}/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`apify dataset ${datasetId}: HTTP ${res.status}`);
  return (await res.json()) as T[];
}

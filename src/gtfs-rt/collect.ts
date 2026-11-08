import type { Env } from './env.ts';
import { readFeedHeader } from './header.ts';

export const FEED_KEY = 'realtime/gtfs-rt/trip-updates.pb';
export const LATEST_KEY = 'realtime/gtfs-rt/latest.json';
/** Upstream refreshes about every 30 s. The cron trigger has one-minute granularity, so each run polls twice. */
export const POLL_INTERVAL_MS = 30_000;
/** Cached at the edge for this long: consumers see data at most ~15 s older than the bucket. */
export const MAX_AGE_SECONDS = 15;
const MAX_FEED_BYTES = 8 * 1024 * 1024;
const FUTURE_TOLERANCE_SECONDS = 300;

export type Outcome =
  | { status: 'published'; timestamp: number; byteLength: number; entities: number }
  | { status: 'unchanged'; timestamp: number }
  | { status: 'stale'; timestamp: number; published: number }
  | { status: 'disabled' };

export interface Deps {
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new Error('Empty GTFS-RT response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_FEED_BYTES) throw new Error('GTFS-RT feed exceeds the size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

const hex = (digest: ArrayBuffer): string => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Fetches the upstream feed once and publishes it as the single latest version. Everything is validated before the
 * first write, so a failed fetch, a truncated or non-protobuf body, a differential feed or an older snapshot leaves
 * the previously published feed in place.
 */
export async function collectOnce(env: Env, deps: Deps = {}): Promise<Outcome> {
  if (!env.GTFS_RT_URL) return { status: 'disabled' };
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const url = new URL(env.GTFS_RT_URL);
  if (url.protocol !== 'https:') throw new Error('GTFS_RT_URL must use HTTPS');
  const headers = new Headers({ Accept: 'application/x-protobuf', 'User-Agent': 'iRail-cdn-gtfs-rt' });
  if (env.GTFS_RT_TOKEN) headers.set(env.GTFS_RT_TOKEN_HEADER || 'x-rt-token', env.GTFS_RT_TOKEN);
  // Redirects are not followed: a credential must never be replayed to another host.
  const response = await fetcher(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GTFS-RT upstream returned HTTP ${response.status}`);
  const bytes = await readBounded(response);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) !== bytes.length) throw new Error('GTFS-RT download is incomplete');

  const header = readFeedHeader(bytes);
  // A standalone snapshot cannot safely expose a differential feed that was not applied to a base.
  if (header.incrementality !== 0) throw new Error('Differential GTFS-RT feeds need a stateful reducer');
  if (header.timestamp > now() / 1000 + FUTURE_TOLERANCE_SECONDS) throw new Error('GTFS-RT feed timestamp lies in the future');

  const previous = await env.DATA.head(FEED_KEY);
  const published = Number(previous?.customMetadata?.feedTimestamp ?? 0);
  if (header.timestamp === published) return { status: 'unchanged', timestamp: header.timestamp };
  if (header.timestamp < published) return { status: 'stale', timestamp: header.timestamp, published };

  const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
  const cacheControl = `public, max-age=${MAX_AGE_SECONDS}`;
  await env.DATA.put(FEED_KEY, bytes, {
    httpMetadata: { contentType: 'application/x-protobuf', cacheControl },
    customMetadata: { feedTimestamp: String(header.timestamp), sha256 },
  });
  // Small description written last. The protobuf itself already carries its timestamp, so the two objects do not
  // need to change atomically.
  const origin = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  await env.DATA.put(LATEST_KEY, `${JSON.stringify({
    format: 'irail-cdn-gtfs-rt',
    version: 1,
    sourceId: env.GTFS_SOURCE_ID ?? 'be.sncb',
    feed: 'trip-updates',
    url: `${origin}/${FEED_KEY}`,
    mediaType: 'application/x-protobuf',
    gtfsRealtimeVersion: header.version,
    incrementality: 'FULL_DATASET',
    feedTimestamp: header.timestamp,
    feedTime: new Date(header.timestamp * 1000).toISOString(),
    fetchedAt: new Date(now()).toISOString(),
    entities: header.entities,
    byteLength: bytes.length,
    sha256,
    retention: 'latest version only',
    attribution: 'NMBS/SNCB real-time data via Belgian Mobility, CC BY 4.0',
    license: 'https://creativecommons.org/licenses/by/4.0/',
  }, null, 2)}\n`, { httpMetadata: { contentType: 'application/json', cacheControl } });
  return { status: 'published', timestamp: header.timestamp, byteLength: bytes.length, entities: header.entities };
}

/**
 * One cron invocation: a poll now and another about 30 s later. Waiting costs wall-clock time, not CPU time. A failure
 * of one poll never prevents the other; the invocation fails (and shows so in the dashboard) only if both fail.
 */
export async function collectMinute(env: Env, scheduledTime: number, deps: Deps = {}): Promise<Outcome[]> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const outcomes: Outcome[] = [];
  const errors: unknown[] = [];
  const poll = async () => {
    try {
      const outcome = await collectOnce(env, deps);
      outcomes.push(outcome);
      console.log(JSON.stringify({ event: 'gtfs-rt', ...outcome }));
    } catch (error) {
      errors.push(error);
      console.error(JSON.stringify({ event: 'gtfs-rt-error', message: error instanceof Error ? error.message : String(error) }));
    }
  };
  await poll();
  const wait = Math.min(POLL_INTERVAL_MS, Math.max(0, scheduledTime + POLL_INTERVAL_MS - now()));
  if (wait > 0) await sleep(wait);
  await poll();
  if (errors.length === 2) throw errors[1];
  return outcomes;
}

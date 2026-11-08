// Acceptance check of the published GTFS-RT feed on its public host: availability, media types, CORS, caching,
// freshness, framing and agreement between trip-updates.pb and latest.json.
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFeedHeader } from '../src/gtfs-rt/header.ts';
import { FEED_KEY, LATEST_KEY } from '../src/gtfs-rt/collect.ts';

export async function checkRealtime(baseUrl, { fetcher = fetch, now = Date.now, maxAgeSeconds = 180 } = {}) {
  const base = baseUrl.replace(/\/+$/u, '');
  const results = [];
  const record = (name, ok, detail = '', severity = 'fail') => results.push({ name, ok, severity: ok ? 'pass' : severity, detail });
  const header = (response, name) => (response.headers.get(name) ?? '').toLowerCase();

  const latestResponse = await fetcher(`${base}/${LATEST_KEY}`);
  record('latest.json GET', latestResponse.ok, `HTTP ${latestResponse.status}`);
  const feedResponse = await fetcher(`${base}/${FEED_KEY}`);
  record('trip-updates.pb GET', feedResponse.ok, `HTTP ${feedResponse.status}`);
  if (!latestResponse.ok || !feedResponse.ok) return results;
  const latest = await latestResponse.json();
  const bytes = new Uint8Array(await feedResponse.arrayBuffer());

  record('trip-updates.pb media type', header(feedResponse, 'content-type').startsWith('application/x-protobuf'), feedResponse.headers.get('content-type') ?? 'none');
  record('latest.json media type', header(latestResponse, 'content-type').startsWith('application/json'), latestResponse.headers.get('content-type') ?? 'none');
  for (const [name, response] of [['trip-updates.pb', feedResponse], ['latest.json', latestResponse]]) {
    record(`${name} CORS`, header(response, 'access-control-allow-origin') === '*', response.headers.get('access-control-allow-origin') ?? 'none');
    const maxAge = /max-age=(\d+)/u.exec(header(response, 'cache-control'));
    record(`${name} short caching`, Boolean(maxAge) && Number(maxAge[1]) <= 60, response.headers.get('cache-control') ?? 'none', 'warn');
  }
  record('edge cache in use', ['hit', 'revalidated', 'updating'].includes(header(feedResponse, 'cf-cache-status')) || header(feedResponse, 'cf-cache-status') === 'miss', feedResponse.headers.get('cf-cache-status') ?? 'no cf-cache-status header (is the domain proxied by Cloudflare?)', 'warn');

  let parsed = null;
  try { parsed = readFeedHeader(bytes); record('protobuf framing and header', true, `${parsed.entities} entities, GTFS-RT ${parsed.version}`); } catch (error) { record('protobuf framing and header', false, error.message); }
  if (parsed) {
    record('full dataset', parsed.incrementality === 0);
    const age = now() / 1000 - parsed.timestamp;
    record('feed is fresh', age >= -60 && age <= maxAgeSeconds, `${Math.round(age)} s old (limit ${maxAgeSeconds} s)`);
    // The two objects are written one after the other: a one-poll difference is normal, a larger one is not.
    record('latest.json matches the protobuf', Math.abs(latest.feedTimestamp - parsed.timestamp) <= 60, `${latest.feedTimestamp} vs ${parsed.timestamp}`);
    if (latest.feedTimestamp === parsed.timestamp) record('sha256 and size match', latest.sha256 === createHash('sha256').update(bytes).digest('hex') && latest.byteLength === bytes.length);
  }
  record('attribution and licence present', Boolean(latest.attribution && latest.license));
  return results;
}

export function renderReport(results) {
  const symbol = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  return `| Check | Result | Detail |\n| --- | --- | --- |\n${results.map((r) => `| ${r.name} | ${symbol[r.severity]} | ${r.detail} |`).join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { strict: { type: 'boolean' }, summary: { type: 'string' } } });
  if (!positionals[0]) { console.error('usage: check-realtime.mjs <public-base-url> [--strict] [--summary file]'); process.exit(2); }
  const results = await checkRealtime(positionals[0]);
  const report = renderReport(results);
  console.log(report);
  if (values.summary) await appendFile(values.summary, `## Live GTFS-RT check\n\n${report}\n`);
  if (values.strict && results.some((result) => result.severity === 'fail')) process.exit(1);
}

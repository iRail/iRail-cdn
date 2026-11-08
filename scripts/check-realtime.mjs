// Acceptance check of the published GTFS-RT feed on its public host: availability, media types, CORS, caching,
// freshness and protobuf framing of the single published object.
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readFeedHeader } from '../src/gtfs-rt/header.ts';
import { FEED_KEY } from '../src/gtfs-rt/collect.ts';

export async function checkRealtime(baseUrl, { fetcher = fetch, now = Date.now, maxAgeSeconds = 180 } = {}) {
  const base = baseUrl.replace(/\/+$/u, '');
  const results = [];
  const record = (name, ok, detail = '', severity = 'fail') => results.push({ name, ok, severity: ok ? 'pass' : severity, detail });
  const header = (response, name) => (response.headers.get(name) ?? '').toLowerCase();

  const response = await fetcher(`${base}/${FEED_KEY}`);
  record('trip-updates.pb GET', response.ok, `HTTP ${response.status}`);
  if (!response.ok) return results;
  const bytes = new Uint8Array(await response.arrayBuffer());

  record('media type', header(response, 'content-type').startsWith('application/x-protobuf'), response.headers.get('content-type') ?? 'none');
  record('CORS', header(response, 'access-control-allow-origin') === '*', response.headers.get('access-control-allow-origin') ?? 'none');
  const maxAge = /max-age=(\d+)/u.exec(header(response, 'cache-control'));
  record('short caching', Boolean(maxAge) && Number(maxAge[1]) <= 60, response.headers.get('cache-control') ?? 'none', 'warn');
  const status = header(response, 'cf-cache-status');
  record('edge cache in use', ['hit', 'miss', 'revalidated', 'updating'].includes(status), status || 'no cf-cache-status header (is the domain proxied by Cloudflare and covered by the Cache Rule?)', 'warn');

  let parsed = null;
  try { parsed = readFeedHeader(bytes); record('protobuf framing and header', true, `${parsed.entities} entities, GTFS-RT ${parsed.version}, ${bytes.length} bytes`); } catch (error) { record('protobuf framing and header', false, error.message); }
  if (parsed) {
    record('full dataset', parsed.incrementality === 0);
    const age = now() / 1000 - parsed.timestamp;
    record('feed is fresh', age >= -60 && age <= maxAgeSeconds, `${Math.round(age)} s old (limit ${maxAgeSeconds} s)`);
  }
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

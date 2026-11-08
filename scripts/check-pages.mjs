// Native deployed-host acceptance check (GET/HEAD, CORS, media types, cache headers, hash verification,
// release consistency). Run it against the real Pages URL after deployment. It reports gaps explicitly:
// a local static server passing this check says nothing about GitHub Pages.
import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ARROW_MEDIA_TYPE, JSONLD_MEDIA_TYPE, sha256 } from './lib/util.mjs';
import { EXTENSION_PROPERTY } from './lib/release.mjs';

export async function checkPages(baseUrl, { fetcher = fetch, sample = 5 } = {}) {
  const base = baseUrl.replace(/\/+$/u, '/');
  const results = [];
  const record = (name, ok, detail = '', severity = 'fail') => results.push({ name, ok, severity: ok ? 'pass' : severity, detail });
  const resolve = (reference, from) => new URL(reference, from).href;
  const manifestUrl = `${base}manifest.jsonld`;
  const response = await fetcher(manifestUrl);
  record('discovery GET', response.ok, `HTTP ${response.status}`);
  if (!response.ok) return results;
  const header = (res, name) => (res.headers.get(name) ?? '').toLowerCase();
  record('discovery media type', header(response, 'content-type').startsWith(JSONLD_MEDIA_TYPE), response.headers.get('content-type') ?? 'none');
  record('discovery CORS', header(response, 'access-control-allow-origin') === '*', response.headers.get('access-control-allow-origin') ?? 'none');
  record('discovery revalidation', /max-age=(\d+)/u.test(header(response, 'cache-control')) && Number(/max-age=(\d+)/u.exec(header(response, 'cache-control'))[1]) <= 600, response.headers.get('cache-control') ?? 'none', 'warn');
  const manifest = await response.json();
  const releaseUrl = resolve(manifest[EXTENSION_PROPERTY]['@id'], manifestUrl).replace(/irail\.json$/u, 'manifest.jsonld');
  const immutable = await (await fetcher(releaseUrl)).json();
  record('release manifest matches discovery', immutable.releaseId === manifest.releaseId && JSON.stringify({ ...immutable, '@id': 0 }) === JSON.stringify({ ...manifest, '@id': 0 }));
  const extensionsUrl = resolve(manifest[EXTENSION_PROPERTY]['@id'], manifestUrl);
  const extensions = await (await fetcher(extensionsUrl)).json();
  const files = [...Object.values(extensions.files).flat()];
  const pages = manifest.connections.pages;
  const targets = [manifest.stops, manifest.trips, manifest.routes, manifest.transfers, ...pages.slice(0, sample).map((page) => page['@id'])];
  for (const iri of targets) {
    const url = resolve(iri, manifestUrl);
    const head = await fetcher(url, { method: 'HEAD' });
    const get = await fetcher(url);
    const bytes = Buffer.from(await get.arrayBuffer());
    const descriptor = files.find((file) => resolve(file.path, manifestUrl) === url);
    const label = new URL(url).pathname.split('/').slice(-2).join('/');
    record(`${label} GET/HEAD`, head.ok && get.ok, `HEAD ${head.status}, GET ${get.status}`);
    record(`${label} integrity`, Boolean(descriptor) && descriptor.sha256 === sha256(bytes) && descriptor.byteLength === bytes.length, descriptor ? 'hash compared with catalog' : 'not cataloged');
    record(`${label} media type`, header(get, 'content-type').startsWith(ARROW_MEDIA_TYPE), get.headers.get('content-type') ?? 'none');
    record(`${label} CORS`, header(get, 'access-control-allow-origin') === '*', get.headers.get('access-control-allow-origin') ?? 'none');
    record(`${label} immutable caching`, /max-age=(\d+)/u.test(header(get, 'cache-control')) && Number(/max-age=(\d+)/u.exec(header(get, 'cache-control'))[1]) >= 3600, get.headers.get('cache-control') ?? 'none', 'warn');
  }
  return results;
}

export function renderReport(results) {
  const symbol = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
  return `| Check | Result | Detail |\n| --- | --- | --- |\n${results.map((r) => `| ${r.name} | ${symbol[r.severity]} | ${r.detail} |`).join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { strict: { type: 'boolean' }, summary: { type: 'string' } } });
  if (!positionals[0]) { console.error('usage: check-pages.mjs <site-url> [--strict] [--summary file]'); process.exit(2); }
  const results = await checkPages(positionals[0]);
  const report = renderReport(results);
  console.log(report);
  if (values.summary) await appendFile(values.summary, `## Native Pages HTTP check\n\n${report}\n`);
  const failures = results.filter((result) => result.severity === 'fail');
  if (failures.length) console.error(`${failures.length} conformance gaps. They are reported, not hidden: resolve them before claiming production LC conformance.`);
  if (values.strict && failures.length) process.exit(1);
}

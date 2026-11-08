// Restores the retained releases of the currently deployed Pages site into a directory, verifying every file
// against the site index and each release's integrity catalog. A fresh Pages deployment keeps only what the
// new artifact contains, so retained bytes must be re-supplied; they are never trusted unverified.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { SITE_INDEX } from './assemble-pages.mjs';
import { RELEASE_EXTENSIONS, RELEASE_MANIFEST } from './lib/release.mjs';
import { formatBytes, normalizePrefix, sha256, sitePath } from './lib/util.mjs';

async function get(fetcher, url, { attempts = 4 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetcher(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new Error(`Cannot fetch ${url}: ${last.message}`);
}

async function mapLimit(items, limit, work) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await work(queue.shift());
  }));
}

/** @returns {Promise<{status: 'empty'|'restored', releases: string[], bytes: number}>} */
export async function restorePages({ baseUrl, outDir, fetcher = fetch, concurrency = 8 }) {
  const base = baseUrl.replace(/\/+$/u, '');
  const indexBytes = await get(fetcher, `${base}/${SITE_INDEX}`);
  if (!indexBytes) return { status: 'empty', releases: [], bytes: 0 }; // first deployment: nothing is published yet
  const index = JSON.parse(indexBytes);
  if (index.format !== 'irail-cdn-site' || index.version !== 1) throw new Error('Unsupported site index');
  const prefix = normalizePrefix(index.prefix);
  let bytes = 0;
  const store = async (relative, content) => {
    const file = path.join(outDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    bytes += content.length;
  };
  const fetchVerified = async (iri, expected) => {
    const relative = sitePath(iri, prefix);
    const content = await get(fetcher, `${base}/${relative}`);
    if (!content) throw new Error(`Published file is missing: ${iri}`);
    if (content.length !== expected.byteLength || sha256(content) !== expected.sha256) throw new Error(`Published file differs from its recorded hash: ${iri}`);
    await store(relative, content);
    return content;
  };
  for (const release of index.releases) {
    await fetchVerified(release.manifest.path, release.manifest);
    const extensionBytes = await fetchVerified(release.extensions.path, release.extensions);
    const extensions = JSON.parse(extensionBytes);
    const descriptors = [extensions.identityStrategy, ...Object.values(extensions.files).flat()];
    await mapLimit(descriptors, concurrency, (descriptor) => fetchVerified(descriptor.path, descriptor));
  }
  return { status: 'restored', releases: index.releases.map((release) => release.releaseId), bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { 'base-url': { type: 'string' }, out: { type: 'string', default: 'build/previous' } } });
  if (!values['base-url']) { console.error('usage: restore-pages.mjs --base-url https://owner.github.io/repo [--out dir]'); process.exit(2); }
  try {
    const result = await restorePages({ baseUrl: values['base-url'], outDir: values.out });
    console.error(result.status === 'empty' ? 'No published site found: first deployment.' : `Restored ${result.releases.join(', ')} (${formatBytes(result.bytes)})`);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.stack ?? error);
    process.exit(1);
  }
}

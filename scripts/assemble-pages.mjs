// Assembles one complete GitHub Pages snapshot: the new immutable release, retained earlier releases,
// latest discovery, a minimal index and .nojekyll. Nothing is written to the destination unless the whole
// candidate validates, so a failed or oversized build leaves the last good candidate in place.
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { RELEASE_EXTENSIONS, RELEASE_MANIFEST, releaseSize } from './lib/release.mjs';
import { formatBytes, normalizePrefix, readJson, sha256 } from './lib/util.mjs';
import { validateRelease, validateSite } from './validate-release.mjs';

export const SITE_INDEX = 'releases/index.json';
const root = path.resolve(import.meta.dirname, '..');
const html = (text) => text.replace(/[&<>"]/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

async function describeRelease(directory, releaseId, prefix) {
  const manifestBytes = await readFile(path.join(directory, 'releases', releaseId, RELEASE_MANIFEST));
  const extensionBytes = await readFile(path.join(directory, 'releases', releaseId, RELEASE_EXTENSIONS));
  const manifest = JSON.parse(manifestBytes);
  const base = `${prefix}/releases/${releaseId}`;
  return {
    releaseId, generatedAt: manifest.generatedAt, coverageStart: manifest.coverageStart, coverageEnd: manifest.coverageEnd,
    bytes: await releaseSize(path.join(directory, 'releases', releaseId)),
    manifest: { path: `${base}/${RELEASE_MANIFEST}`, byteLength: manifestBytes.length, sha256: sha256(manifestBytes) },
    extensions: { path: `${base}/${RELEASE_EXTENSIONS}`, byteLength: extensionBytes.length, sha256: sha256(extensionBytes) },
  };
}

async function releaseIds(directory) {
  const entries = await readdir(path.join(directory, 'releases'), { withFileTypes: true }).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)));
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function assemblePages({ stagingDir, previousDir, outDir, prefix = '', maxReleases, maxSiteBytes, repository }) {
  prefix = normalizePrefix(prefix);
  const retention = (await readJson(path.join(root, 'config/sncb.json'))).retention;
  maxReleases ??= retention.maxReleases;
  maxSiteBytes ??= retention.maxSiteBytes;
  const staged = await releaseIds(stagingDir);
  if (staged.length !== 1) throw new Error(`Expected exactly one staged release, found ${staged.length}`);
  const [newId] = staged;
  await validateRelease(stagingDir, newId, { prefix, deep: true });
  const candidates = [{ ...await describeRelease(stagingDir, newId, prefix), source: stagingDir, isNew: true }];

  for (const id of previousDir ? await releaseIds(previousDir) : []) {
    const previous = await describeRelease(previousDir, id, prefix);
    if (id === newId) {
      if (previous.extensions.sha256 !== candidates[0].extensions.sha256) throw new Error(`Release ${id} already exists with different bytes; immutable releases cannot be replaced`);
      continue; // identical content: the retained copy is the same release
    }
    await validateRelease(previousDir, id, { prefix, deep: false }); // hashes of every cataloged file, against restored bytes
    candidates.push({ ...previous, source: previousDir, isNew: false });
  }
  candidates.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0));
  const kept = [];
  const dropped = [];
  let total = 0;
  for (const candidate of candidates) {
    const fits = total + candidate.bytes <= maxSiteBytes && kept.length < maxReleases;
    if (fits) { kept.push(candidate); total += candidate.bytes; } else if (candidate.isNew) {
      throw new Error(`Release ${candidate.releaseId} (${formatBytes(candidate.bytes)}) does not fit the ${formatBytes(maxSiteBytes)} site budget or retention limit; keeping the last good deployment`);
    } else dropped.push(candidate.releaseId);
  }

  const temporary = `${path.resolve(outDir)}.assembling`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(path.join(temporary, 'releases'), { recursive: true });
  try {
    for (const release of kept) await cp(path.join(release.source, 'releases', release.releaseId), path.join(temporary, 'releases', release.releaseId), { recursive: true });
    const latest = kept[0];
    const latestManifest = await readJson(path.join(temporary, 'releases', latest.releaseId, RELEASE_MANIFEST));
    await writeFile(path.join(temporary, RELEASE_MANIFEST), `${JSON.stringify({ ...latestManifest, '@id': `${prefix}/${RELEASE_MANIFEST}` }, null, 2)}\n`);
    const index = {
      format: 'irail-cdn-site', version: 1, prefix, latest: latest.releaseId,
      retention: { maxReleases, maxSiteBytes }, releases: kept.map(({ source, isNew, ...release }) => release),
    };
    await writeFile(path.join(temporary, SITE_INDEX), `${JSON.stringify(index, null, 2)}\n`);
    await writeFile(path.join(temporary, '.nojekyll'), '');
    const rows = index.releases.map((release) => `<li><a href="releases/${html(release.releaseId)}/manifest.jsonld">${html(release.releaseId)}</a> — ${html(release.coverageStart)} to ${html(release.coverageEnd)} (${formatBytes(release.bytes)})</li>`).join('\n');
    await writeFile(path.join(temporary, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iRail Linked Connections 2.0-alpha</title>
<h1>iRail Linked Connections 2.0-alpha</h1>
<p>NMBS/SNCB timetable as <a href="https://linkedconnections.org/specification/2-0-alpha">Linked Connections 2.0-alpha</a>. Start at <a href="manifest.jsonld">manifest.jsonld</a> (latest release, ${html(latest.releaseId)}); releases below are immutable.</p>
<ul>
${rows}
</ul>
${repository ? `<p>Source: <a href="https://github.com/${html(repository)}">${html(repository)}</a></p>` : ''}
`);
    await validateSite(temporary, { prefix, deepRelease: newId });
    await rm(outDir, { recursive: true, force: true });
    await rename(temporary, path.resolve(outDir));
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { latest: kept[0].releaseId, kept: kept.map((release) => release.releaseId), dropped, bytes: total, budget: maxSiteBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    staging: { type: 'string', default: 'build/staging' }, previous: { type: 'string' }, out: { type: 'string', default: 'build/site' }, prefix: { type: 'string', default: '' },
    'max-releases': { type: 'string' }, 'max-site-bytes': { type: 'string' }, repository: { type: 'string' },
  } });
  try {
    const result = await assemblePages({
      stagingDir: values.staging, previousDir: values.previous, outDir: values.out, prefix: values.prefix, repository: values.repository,
      maxReleases: values['max-releases'] ? Number(values['max-releases']) : undefined, maxSiteBytes: values['max-site-bytes'] ? Number(values['max-site-bytes']) : undefined,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.stack ?? error);
    process.exit(1);
  }
}

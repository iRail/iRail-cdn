// Finalizes a converted release: adds the iRail extension link to the LC manifest, writes the integrity
// catalog (irail.json) after all data bytes are final, and keeps core Arrow bytes untouched.
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableFromIPC } from 'apache-arrow';
import { extensionVersion } from '../../specs/schemas.mjs';
import { ARROW_MEDIA_TYPE, readJson, sha256, walk } from './util.mjs';

export const EXTENSION_PROPERTY = 'irail:extensions';
export const IRAIL_VOCAB = 'https://irail.be/vocab/';
export const TIME_PARTITION_SECONDS = 21600;
export const MAX_PAGE_ROWS = 50000;
export const RELEASE_MANIFEST = 'manifest.jsonld';
export const RELEASE_EXTENSIONS = 'irail.json';

export const descriptorFor = (publicPath, bytes, rowCount, mediaType = ARROW_MEDIA_TYPE) => ({
  path: publicPath, rowCount, byteLength: bytes.length, sha256: sha256(bytes), mediaType,
});

/** Descriptors for every `.arrow` file of a release, keyed by their schema `dataset`. */
export async function catalogFiles(releaseDir, releasePath) {
  const files = {};
  for (const relative of await walk(releaseDir)) {
    if (!relative.endsWith('.arrow')) continue;
    const bytes = await readFile(path.join(releaseDir, relative));
    const table = tableFromIPC(bytes);
    const dataset = table.schema.metadata.get('dataset');
    if (!dataset) throw new Error(`${relative} has no dataset metadata`);
    const descriptor = descriptorFor(`${releasePath}/${relative}`, bytes, table.numRows);
    if (dataset === 'connections') (files.connections ??= []).push(descriptor);
    else if (files[dataset]) throw new Error(`Duplicate ${dataset} file: ${relative}`);
    else files[dataset] = descriptor;
  }
  files.connections?.sort((a, b) => (a.path < b.path ? -1 : 1));
  return files;
}

/**
 * Writes `irail.json` and the extended manifests. `staged.manifest` is the converter's discovery document,
 * whose `@id` is the mutable root; the immutable copy inside the release gets its own `@id`.
 */
export async function finalizeRelease({ stagingDir, releaseId, prefix, sourceId, strategy, strategySha256, sources, capabilities, diagnostics, status = 'available' }) {
  const releaseDir = path.join(stagingDir, 'releases', releaseId);
  const releasePath = `${prefix}/releases/${releaseId}`;
  const manifest = await readJson(path.join(releaseDir, RELEASE_MANIFEST));
  if (manifest.releaseId !== releaseId || manifest.schemaVersion !== '2-alpha') throw new Error('Converter manifest does not describe the requested release');
  const files = await catalogFiles(releaseDir, releasePath);
  const strategyBytes = await readFile(path.join(releaseDir, 'identity-strategy.json'));
  const day = (iso) => Number(iso.slice(0, 10).replaceAll('-', ''));
  const regions = [...new Set(manifest.connections.pages.map((page) => page.region).filter(Boolean))].sort().map((iri) => ({ iri }));
  const extensions = {
    format: 'irail-cdn-extensions', version: extensionVersion, status, sourceId,
    identityProfile: strategy.identityProfile, identityBase: strategy.identityBase,
    releaseId, generatedAt: manifest.generatedAt,
    sources,
    serviceDates: { start: day(manifest.coverageStart), end: day(manifest.coverageEnd) },
    partitioning: { timePartitionSeconds: TIME_PARTITION_SECONDS, maxRows: MAX_PAGE_ROWS, regions },
    capabilities, diagnostics, files,
    identityStrategy: {
      path: `${releasePath}/identity-strategy.json`, byteLength: strategyBytes.length, sha256: strategySha256, mediaType: 'application/json',
    },
  };
  const extensionBytes = `${JSON.stringify(extensions, null, 2)}\n`;
  await writeFile(path.join(releaseDir, RELEASE_EXTENSIONS), extensionBytes);

  const extended = {
    ...manifest,
    '@context': [manifest['@context'], { irail: IRAIL_VOCAB }],
    [EXTENSION_PROPERTY]: { '@id': `${releasePath}/${RELEASE_EXTENSIONS}` },
  };
  const releaseManifest = { ...extended, '@id': `${releasePath}/${RELEASE_MANIFEST}` };
  const releaseBytes = `${JSON.stringify(releaseManifest, null, 2)}\n`;
  await writeFile(path.join(releaseDir, RELEASE_MANIFEST), releaseBytes);
  await writeFile(path.join(stagingDir, RELEASE_MANIFEST), `${JSON.stringify({ ...extended, '@id': `${prefix}/${RELEASE_MANIFEST}` }, null, 2)}\n`);
  return { releaseDir, manifest: releaseManifest, extensions, manifestBytes: releaseBytes.length, extensionBytes: extensionBytes.length };
}

export async function releaseSize(releaseDir) {
  let total = 0;
  for (const relative of await walk(releaseDir)) total += (await stat(path.join(releaseDir, relative))).size;
  return total;
}

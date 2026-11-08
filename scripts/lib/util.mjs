import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const ARROW_MEDIA_TYPE = 'application/vnd.apache.arrow.file';
export const JSONLD_MEDIA_TYPE = 'application/ld+json';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** All regular files below a directory, as sorted POSIX-style relative paths. */
export async function walk(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

export async function directoryBytes(root) {
  let total = 0;
  for (const file of await walk(root)) total += (await stat(path.join(root, file))).size;
  return total;
}

export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

/** Normalizes an origin-relative public prefix: '' (domain root) or '/segment[/segment]'. */
export function normalizePrefix(prefix = '') {
  if (prefix === '' || prefix === '/') return '';
  if (!/^\/(?!\/)/.test(prefix) || /[%?#\\\s]/.test(prefix) || prefix.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`Invalid URL prefix: ${prefix}`);
  }
  return prefix.replace(/\/+$/, '');
}

/** Maps a manifest IRI (origin-relative, under the prefix) to a site-relative path. */
export function sitePath(iri, prefix) {
  if (typeof iri !== 'string' || !iri.startsWith(`${prefix}/`) || iri.includes('?') || iri.includes('#')) {
    throw new Error(`IRI is not under the public prefix '${prefix}': ${iri}`);
  }
  const relative = iri.slice(prefix.length + 1);
  if (relative.split('/').some((part) => part === '' || part === '.' || part === '..')) throw new Error(`Unsafe path in IRI: ${iri}`);
  return relative;
}

export function brusselsDate(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

export function addDays(yyyymmdd, days) {
  const date = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + days));
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

// Bounded Node wrapper around the gtfs2lc `feat-arrow` CLI. It never re-implements GTFS parsing,
// calendar expansion or connection generation: it verifies the converter source, extracts a disposable
// copy of the archive, runs the CLI and returns the staging directory.
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { readJson, sha256 } from './lib/util.mjs';

const exec = promisify(execFile);
const GTFS_FILES = /^[A-Za-z0-9_.-]+\.txt$/;

/** Extracts an archive into an empty directory. Only flat GTFS `.txt` members are accepted. */
export async function extractArchive(archive, directory) {
  const bytes = await readFile(archive);
  const entries = unzipSync(new Uint8Array(bytes));
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const names = [];
  for (const [name, content] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    if (!GTFS_FILES.test(name)) throw new Error(`Unexpected archive member: ${name}`);
    await writeFile(path.join(directory, name), content);
    names.push(name);
  }
  for (const required of ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt']) {
    if (!names.includes(required)) throw new Error(`GTFS archive lacks ${required}`);
  }
  return { sha256: sha256(bytes), byteLength: bytes.length, files: names.sort() };
}

/**
 * The converter follows the latest `feat-arrow`, so there is no commit to compare with: the exact commit is read from
 * the checkout and recorded in the release. A checkout with local modifications is refused, because its commit would
 * not describe what ran.
 */
export async function verifyConverter(converterDir, source, { allowModified = false } = {}) {
  const cli = path.join(converterDir, 'bin', 'gtfs2lc.js');
  await readFile(cli).catch(() => { throw new Error(`gtfs2lc CLI not found at ${cli}`); });
  let commit = null;
  let dirty = false;
  try {
    commit = (await exec('git', ['-C', converterDir, 'rev-parse', 'HEAD'])).stdout.trim();
    dirty = (await exec('git', ['-C', converterDir, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim() !== '';
  } catch { /* not a git checkout */ }
  if (!commit || (dirty && !allowModified)) {
    throw new Error(`gtfs2lc at ${converterDir} is ${commit ? `${commit} with local modifications` : 'not a git checkout'}: its commit would not describe the build (use a clean checkout of ${source.ref}${allowModified ? '' : ', or --allow-modified for development'})`);
  }
  return { cli, commit, ref: source.ref, dirty, version: (await readJson(path.join(converterDir, 'package.json'))).version };
}

function run(command, args, { timeoutMs, logFile }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const keep = (chunk) => { log = (log + chunk).slice(-20000); process.stderr.write(chunk); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = timeoutMs ? setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`gtfs2lc exceeded ${timeoutMs} ms`)); }, timeoutMs) : null;
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(log);
      else reject(new Error(`gtfs2lc exited with status ${code}\n${log.split('\n').slice(-12).join('\n')}`));
    });
  });
}

/**
 * Converts an extracted GTFS directory into `<stagingDir>/manifest.jsonld` and `<stagingDir>/releases/<releaseId>/`.
 * `stagingDir` must be fresh: a stale manifest would imply a successful conversion that did not happen.
 */
export async function convertGtfs({
  gtfsDir, stagingDir, converterDir, converterSource: pin, strategyPath, sourceId, releaseId, startDate, endDate,
  urlPrefix, regions = 1, license, rights, realtimePath, memoryMb = 12000, timeoutMs = 5 * 60 * 60 * 1000, allowModified = false,
}) {
  const converter = await verifyConverter(converterDir, pin, { allowModified });
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  const args = [
    `--max-old-space-size=${memoryMb}`, converter.cli, path.resolve(gtfsDir),
    '--format', 'arrow', '--profile', pin.profile, '--source-id', sourceId, '--iri-strategy', path.resolve(strategyPath),
    '--start-date', startDate, '--end-date', endDate, '--release-id', releaseId, '--url-prefix', urlPrefix === '' ? '/' : urlPrefix,
    '--regions', String(regions), '--output', path.resolve(stagingDir),
  ];
  if (license) args.push('--license', license);
  if (rights) args.push('--rights', rights);
  if (realtimePath) args.push('--realtime', path.resolve(realtimePath));
  await run(process.execPath, args, { timeoutMs });
  return { converter, stagingDir, releaseDir: path.join(stagingDir, 'releases', releaseId) };
}

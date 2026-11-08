// Validates an assembled site (or staging directory): LC core conformance of every Arrow file, foreign keys,
// page bounds/regions, iRail catalog hashes/counts and static-extension joins. Reads files only.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tableFromIPC } from 'apache-arrow';
import { coreDefinitions, definitions, extensionVersion, schemaFor } from '../specs/schemas.mjs';
import { EXTENSION_PROPERTY, RELEASE_EXTENSIONS, RELEASE_MANIFEST } from './lib/release.mjs';
import { ARROW_MEDIA_TYPE, normalizePrefix, readJson, sha256, sitePath, walk } from './lib/util.mjs';

const LC_CONTEXT = 'https://linkedconnections.org/specification/2-0-alpha/context.jsonld';
const CORE_TABLES = ['stops', 'trips', 'routes', 'transfers'];
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const ENUM_MAX = 3;

class Problems {
  list = [];
  add(message) { if (this.list.length < 200) this.list.push(message); this.count = (this.count ?? 0) + 1; }
  check(condition, message) { if (!condition) this.add(message); return Boolean(condition); }
}

const absoluteHttp = (value) => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } };
const column = (table, name) => table.getChild(name);
const numbers = (table, name) => column(table, name).toArray();

function checkSchema(table, name, releaseId, problems, label) {
  const expected = schemaFor(name).fields.map((field) => [field.name, field.type.toString(), field.nullable]);
  const actual = table.schema.fields.map((field) => [field.name, field.type.toString(), field.nullable]);
  const core = Object.hasOwn(coreDefinitions, name);
  // Consumers ignore appended nullable columns, but this provider publishes exactly the pinned baseline.
  problems.check(JSON.stringify(actual) === JSON.stringify(expected), `${label}: columns differ from the pinned ${name} schema`);
  const meta = table.schema.metadata;
  problems.check(meta.get('dataset') === name, `${label}: dataset metadata is ${meta.get('dataset')}, expected ${name}`);
  problems.check(meta.get('releaseId') === releaseId, `${label}: releaseId metadata is ${meta.get('releaseId')}`);
  problems.check(meta.get('schemaVersion') === (core ? '2-alpha' : extensionVersion), `${label}: schemaVersion metadata is ${meta.get('schemaVersion')}`);
}

async function readArrow(file, problems, label) {
  const bytes = await readFile(file);
  if (!problems.check(bytes.subarray(0, 6).toString('latin1') === 'ARROW1' && bytes.subarray(-6).toString('latin1') === 'ARROW1', `${label}: not an Arrow IPC file (ARROW1 framing)`)) return null;
  return { bytes, table: tableFromIPC(bytes) };
}

function checkManifest(manifest, { releaseId, prefix, expectedId, files, problems, label }) {
  problems.check(manifest['@type'] === 'Timetable', `${label}: @type must be Timetable`);
  problems.check(manifest.schemaVersion === '2-alpha', `${label}: schemaVersion must be 2-alpha`);
  problems.check(manifest.releaseId === releaseId, `${label}: releaseId ${manifest.releaseId} != ${releaseId}`);
  problems.check(manifest['@id'] === expectedId, `${label}: @id ${manifest['@id']} != ${expectedId}`);
  const context = [manifest['@context']].flat();
  problems.check(context[0] === LC_CONTEXT, `${label}: first @context entry must be the LC 2-alpha context`);
  problems.check(typeof manifest.timeZone === 'string' && manifest.timeZone, `${label}: timeZone is required`);
  for (const forbidden of ['format', 'version', 'files', 'status', 'calls', 'planning', 'sha256', 'rowCount', 'byteLength', 'mediaType']) {
    problems.check(manifest[forbidden] === undefined, `${label}: LC manifest must not contain ${forbidden}`);
  }
  for (const name of CORE_TABLES) {
    if (!problems.check(typeof manifest[name] === 'string', `${label}: ${name} must be an IRI string`)) continue;
    try {
      const relative = sitePath(manifest[name], prefix);
      problems.check(relative === `releases/${releaseId}/${name}.arrow`, `${label}: ${name} points outside its release: ${manifest[name]}`);
      problems.check(files.has(relative), `${label}: ${name} file is missing: ${manifest[name]}`);
    } catch (error) { problems.add(`${label}: ${error.message}`); }
  }
  const connections = manifest.connections;
  if (!problems.check(connections?.['@type'] === 'ConnectionCollection' && Array.isArray(connections.pages) && connections.pages.length > 0, `${label}: connections must be a ConnectionCollection with pages`)) return [];
  const seen = new Set();
  for (const page of connections.pages) {
    try {
      const relative = sitePath(page['@id'], prefix);
      problems.check(relative.startsWith(`releases/${releaseId}/connections/`) && relative.endsWith('.arrow'), `${label}: page outside release: ${page['@id']}`);
      problems.check(files.has(relative), `${label}: page file is missing: ${page['@id']}`);
      problems.check(!seen.has(relative), `${label}: page listed twice: ${page['@id']}`);
      seen.add(relative);
    } catch (error) { problems.add(`${label}: ${error.message}`); }
    for (const forbidden of ['sha256', 'rowCount', 'byteLength', 'mediaType']) problems.check(page[forbidden] === undefined, `${label}: page must not contain ${forbidden}`);
  }
  const link = manifest[EXTENSION_PROPERTY]?.['@id'];
  problems.check(link === `${prefix}/releases/${releaseId}/${RELEASE_EXTENSIONS}`, `${label}: ${EXTENSION_PROPERTY} link is ${link}`);
  return connections.pages;
}

/** Validates one release directory below `siteDir`. `deep: false` only verifies manifests and catalog hashes. */
export async function validateRelease(siteDir, releaseId, { prefix = '', deep = true } = {}) {
  prefix = normalizePrefix(prefix);
  const problems = new Problems();
  const report = { releaseId, rows: {}, pages: 0, bytes: 0 };
  const releaseRoot = `releases/${releaseId}`;
  const releaseDir = path.join(siteDir, releaseRoot);
  if (!RELEASE_ID.test(releaseId)) throw new Error(`Invalid release id: ${releaseId}`);
  const allFiles = new Set((await walk(siteDir)).filter((file) => file.startsWith(`${releaseRoot}/`)));
  const manifest = await readJson(path.join(releaseDir, RELEASE_MANIFEST));
  const pages = checkManifest(manifest, { releaseId, prefix, expectedId: `${prefix}/${releaseRoot}/${RELEASE_MANIFEST}`, files: allFiles, problems, label: 'manifest' });
  const extensions = await readJson(path.join(releaseDir, RELEASE_EXTENSIONS));
  problems.check(extensions.format === 'irail-cdn-extensions' && extensions.version === extensionVersion, `irail.json: unsupported profile ${extensions.format}/${extensions.version}`);
  problems.check(extensions.releaseId === releaseId, 'irail.json: releaseId mismatch');

  // Integrity catalog: every Arrow file, exact hashes/lengths, nothing extra.
  const described = new Map();
  for (const [name, entry] of Object.entries(extensions.files ?? {})) {
    for (const descriptor of Array.isArray(entry) ? entry : [entry]) {
      problems.check(!described.has(descriptor.path), `catalog lists ${descriptor.path} twice`);
      described.set(descriptor.path, { ...descriptor, dataset: name });
    }
  }
  const arrowFiles = [...allFiles].filter((file) => file.endsWith('.arrow'));
  const listed = new Set();
  for (const [iri, descriptor] of described) {
    let relative;
    try { relative = sitePath(iri, prefix); } catch (error) { problems.add(`catalog: ${error.message}`); continue; }
    listed.add(relative);
    if (!problems.check(allFiles.has(relative), `catalog file is missing: ${iri}`)) continue;
    const bytes = await readFile(path.join(siteDir, relative));
    report.bytes += bytes.length;
    problems.check(bytes.length === descriptor.byteLength, `catalog byteLength differs: ${iri}`);
    problems.check(sha256(bytes) === descriptor.sha256, `catalog sha256 differs: ${iri}`);
    problems.check(descriptor.mediaType === ARROW_MEDIA_TYPE, `catalog mediaType differs: ${iri}`);
  }
  for (const file of arrowFiles) problems.check(listed.has(file), `Arrow file is not in the integrity catalog: ${file}`);
  const strategyIri = extensions.identityStrategy?.path;
  try {
    const bytes = await readFile(path.join(siteDir, sitePath(strategyIri, prefix)));
    problems.check(sha256(bytes) === extensions.identityStrategy.sha256 && bytes.length === extensions.identityStrategy.byteLength, 'identity strategy descriptor differs from bytes');
  } catch (error) { problems.add(`identity strategy: ${error.message}`); }
  const known = new Set([...arrowFiles, `${releaseRoot}/${RELEASE_MANIFEST}`, `${releaseRoot}/${RELEASE_EXTENSIONS}`, `${releaseRoot}/identity-strategy.json`]);
  for (const file of allFiles) problems.check(known.has(file) && !/(^|\/)(calls|planning)\b/u.test(file), `unexpected release file: ${file}`);
  report.pages = pages.length;
  if (!deep) return finish(problems, report);

  // Core dictionaries.
  const tables = {};
  for (const name of [...CORE_TABLES, 'stopEnrichment', 'tripEnrichment', 'routeEnrichment', ...(extensions.files?.stations ? ['stations'] : []), ...(extensions.files?.headsigns ? ['headsigns'] : []), ...(extensions.files?.platforms ? ['platforms'] : [])]) {
    const descriptor = extensions.files?.[name];
    if (!problems.check(descriptor && !Array.isArray(descriptor), `catalog has no ${name} descriptor`)) continue;
    const relative = sitePath(descriptor.path, prefix);
    const loaded = await readArrow(path.join(siteDir, relative), problems, relative);
    if (!loaded) continue;
    checkSchema(loaded.table, name, releaseId, problems, relative);
    problems.check(loaded.table.numRows === descriptor.rowCount, `${relative}: row count differs from catalog`);
    tables[name] = loaded.table;
    report.rows[name] = loaded.table.numRows;
  }
  const { stops, trips, routes, transfers } = tables;
  if (!stops || !trips || !routes || !transfers) return finish(problems, report);
  const iris = new Set();
  for (const [name, table] of Object.entries({ stops, trips, routes })) {
    const column = table.getChild('iri');
    for (let i = 0; i < table.numRows; i++) {
      const iri = column.get(i);
      problems.check(absoluteHttp(iri), `${name}[${i}] has an invalid iri`);
      problems.check(!iris.has(iri), `${name}[${i}] duplicates the iri ${iri}`);
      iris.add(iri);
    }
  }
  const parent = numbers(stops, 'parentIdx');
  const regionIri = column(stops, 'regionIri');
  for (let i = 0; i < stops.numRows; i++) {
    problems.check(parent[i] >= -1 && parent[i] < stops.numRows && parent[i] !== i, `stops[${i}] has an invalid parentIdx`);
    let node = i; let steps = 0;
    while (node >= 0 && parent[node] >= 0 && steps++ <= stops.numRows) node = parent[node];
    if (steps > stops.numRows) { problems.add(`stops[${i}] belongs to a cyclic hierarchy`); break; }
  }
  const routeOfTrip = numbers(trips, 'routeIdx');
  for (let i = 0; i < trips.numRows; i++) if (routeOfTrip[i] < 0 || routeOfTrip[i] >= routes.numRows) problems.add(`trips[${i}] has an invalid routeIdx`);
  const [fromStop, toStop, type, fromTrip, toTrip, fromRoute, toRoute] = ['fromStopIdx', 'toStopIdx', 'transferType', 'fromTripIdx', 'toTripIdx', 'fromRouteIdx', 'toRouteIdx'].map((name) => column(transfers, name));
  const minTime = column(transfers, 'minTransferTime');
  for (let i = 0; i < transfers.numRows; i++) {
    const kind = type.get(i);
    problems.check(kind >= 0 && kind <= 5, `transfers[${i}] has an unsupported type`);
    for (const [name, col, limit] of [['fromStopIdx', fromStop, stops.numRows], ['toStopIdx', toStop, stops.numRows], ['fromTripIdx', fromTrip, trips.numRows], ['toTripIdx', toTrip, trips.numRows], ['fromRouteIdx', fromRoute, routes.numRows], ['toRouteIdx', toRoute, routes.numRows]]) {
      const value = col.get(i);
      problems.check(value === null || (value >= 0 && value < limit), `transfers[${i}].${name} is out of range`);
    }
    if (kind <= 3) problems.check(fromStop.get(i) !== null && toStop.get(i) !== null, `transfers[${i}] of type ${kind} requires both stops`);
    if (kind === 2) problems.check(minTime.get(i) !== null, `transfers[${i}] of type 2 requires minTransferTime`);
    if (kind >= 4) problems.check(fromTrip.get(i) !== null && toTrip.get(i) !== null && minTime.get(i) === null, `transfers[${i}] of type ${kind} requires both trips and no duration`);
  }

  // Connection pages.
  let minDeparture = Infinity; let maxDeparture = -Infinity; let maxPageRows = 0; let total = 0;
  for (const page of pages) {
    const relative = sitePath(page['@id'], prefix);
    if (!allFiles.has(relative)) continue; // already reported by the manifest check
    const loaded = await readArrow(path.join(siteDir, relative), problems, relative);
    if (!loaded) continue;
    const { table } = loaded;
    checkSchema(table, 'connections', releaseId, problems, relative);
    const meta = table.schema.metadata;
    const epoch = Number(meta.get('epochSeconds'));
    problems.check(Number.isSafeInteger(epoch) && epoch === Number(page.epochSeconds), `${relative}: epochSeconds metadata differs from the page list`);
    problems.check((meta.get('region') ?? undefined) === page.region, `${relative}: region metadata differs from the page list`);
    problems.check(Date.parse(meta.get('minDepartureTime')) === Date.parse(page.minDepartureTime) && Date.parse(meta.get('maxDepartureTime')) === Date.parse(page.maxDepartureTime), `${relative}: bounds metadata differs from the page list`);
    problems.check(table.numRows > 0, `${relative}: empty page`);
    const dep = numbers(table, 'departureTimeOffset'); const arr = numbers(table, 'arrivalTimeOffset');
    const depStop = numbers(table, 'departureStopIdx'); const arrStop = numbers(table, 'arrivalStopIdx');
    const tripIdx = numbers(table, 'tripIdx'); const seq = numbers(table, 'stopSequence'); const arrSeq = numbers(table, 'arrivalStopSequence');
    const pickup = numbers(table, 'pickupType'); const dropOff = numbers(table, 'dropOffType'); const date = numbers(table, 'serviceDate');
    const iriColumn = column(table, 'iri');
    const keys = new Set();
    let last = -Infinity;
    for (let i = 0; i < table.numRows; i++) {
      const bad = (message) => problems.add(`${relative}[${i}]: ${message}`);
      const departure = epoch + dep[i];
      if (departure < last) bad('departures are not sorted');
      last = departure;
      if (arr[i] < dep[i]) bad('arrives before departure');
      if (!(arrSeq[i] > seq[i])) bad('arrivalStopSequence must exceed stopSequence');
      if (depStop[i] < 0 || depStop[i] >= stops.numRows || arrStop[i] < 0 || arrStop[i] >= stops.numRows) bad('stop index out of range');
      if (tripIdx[i] < 0 || tripIdx[i] >= trips.numRows) bad('trip index out of range');
      if (pickup[i] > ENUM_MAX || dropOff[i] > ENUM_MAX) bad('pickup/drop-off type out of range');
      const day = String(date[i]);
      if (!/^\d{8}$/.test(day) || Number.isNaN(Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`))) bad('invalid serviceDate');
      const key = `${tripIdx[i]}/${date[i]}/${seq[i]}`;
      if (keys.has(key)) bad(`duplicate connection ${key}`);
      keys.add(key);
      if (!iriColumn.get(i)) bad('missing iri');
      if (page.region) {
        if (regionIri.get(depStop[i]) !== page.region) bad('departure stop is outside the page region');
        if (!page.arrivalRegions?.includes(regionIri.get(arrStop[i]))) bad('arrival stop region is not listed in arrivalRegions');
      }
    }
    problems.check(Date.parse(page.minDepartureTime) / 1000 === epoch + dep[0] && Date.parse(page.maxDepartureTime) / 1000 === last, `${relative}: bounds differ from the actual departures`);
    minDeparture = Math.min(minDeparture, epoch + dep[0]); maxDeparture = Math.max(maxDeparture, last);
    maxPageRows = Math.max(maxPageRows, table.numRows); total += table.numRows;
  }
  report.rows.connections = total; report.maxPageRows = maxPageRows;
  problems.check(total > 0, 'release has no connections');
  problems.check(Date.parse(manifest.coverageStart) / 1000 === minDeparture, 'coverageStart differs from the earliest departure');
  problems.check(Date.parse(manifest.coverageEnd) / 1000 > maxDeparture, 'coverageEnd must exceed the latest departure');

  // iRail static side tables share the core dictionaries' indices and IRIs.
  for (const [extra, core, indexName, rawName] of [['stopEnrichment', stops, 'stopIdx', 'stopId'], ['tripEnrichment', trips, 'tripIdx', 'tripId'], ['routeEnrichment', routes, 'routeIdx', 'routeId']]) {
    const table = tables[extra];
    if (!table) continue;
    problems.check(table.numRows === core.numRows, `${extra} must have one row per core row`);
    const idx = numbers(table, indexName); const raw = column(table, rawName); const iri = column(table, 'iri'); const coreIri = column(core, 'iri');
    const rawIds = new Set();
    for (let i = 0; i < table.numRows; i++) {
      if (!problems.check(idx[i] >= 0 && idx[i] < core.numRows && iri.get(i) === coreIri.get(idx[i]), `${extra}[${i}] disagrees with the core iri`)) break;
      problems.check(!rawIds.has(raw.get(i)), `${extra}: duplicate ${rawName} ${raw.get(i)}`);
      rawIds.add(raw.get(i));
    }
  }
  const tripExtra = tables.tripEnrichment;
  if (tripExtra) {
    const route = column(tripExtra, 'routeIri'); const idx = numbers(tripExtra, 'tripIdx');
    for (let i = 0; i < tripExtra.numRows; i++) if (route.get(i) !== column(routes, 'iri').get(routeOfTrip[idx[i]])) { problems.add(`tripEnrichment[${i}].routeIri disagrees with trips.routeIdx`); break; }
  }
  problems.check((extensions.capabilities?.stations === 'available') === Boolean(extensions.files?.stations), 'stations capability and catalog disagree');
  problems.check((extensions.capabilities?.headsigns === 'available') === Boolean(extensions.files?.headsigns), 'headsigns capability and catalog disagree');
  problems.check((extensions.capabilities?.platforms === 'available') === Boolean(extensions.files?.platforms), 'platforms capability and catalog disagree');
  if (tables.platforms) {
    // A platform is <station IRI>#<code> and hangs off exactly one core stop; the core itself holds stations only.
    const { platforms } = tables;
    const stopIdx = numbers(platforms, 'stopIdx'); const iri = column(platforms, 'iri'); const station = column(platforms, 'stationIri'); const code = column(platforms, 'platformCode');
    const stopIri = column(stops, 'iri'); const seen = new Set();
    for (let i = 0; i < platforms.numRows; i++) {
      const ok = stopIdx[i] >= 0 && stopIdx[i] < stops.numRows && station.get(i) === stopIri.get(stopIdx[i]) && iri.get(i) === `${station.get(i)}#${encodeURIComponent(code.get(i))}` && !seen.has(iri.get(i));
      if (!problems.check(ok, `platforms[${i}] is not a unique <station IRI>#<platform> of its core stop`)) break;
      seen.add(iri.get(i));
    }
    for (let i = 0; i < stops.numRows; i++) if (parent[i] !== -1) { problems.add('stops must be station-level when platforms are published separately'); break; }
  }
  if (tables.headsigns) {
    // One row per distinct trip headsign: a client can translate any trips.headsign by exact match.
    const have = new Set(column(tables.headsigns, 'headsign').toArray());
    const want = new Set(column(trips, 'headsign').toArray().filter(Boolean));
    problems.check(have.size === tables.headsigns.numRows, 'headsigns contains a duplicate headsign');
    problems.check(have.size === want.size && [...want].every((value) => have.has(value)), 'headsigns must list exactly the distinct trips.headsign values');
  }
  if (tables.stations) {
    const { stations: curated, stopEnrichment } = tables;
    const seen = new Set();
    const iri = column(curated, 'iri'); const lat = numbers(curated, 'lat'); const lon = numbers(curated, 'lon'); const name = column(curated, 'name');
    for (let i = 0; i < curated.numRows; i++) {
      problems.check(/^http:\/\/irail\.be\/stations\/NMBS\/\d{9}$/u.test(iri.get(i)) && !seen.has(iri.get(i)), `stations[${i}] has an invalid or duplicate iri`);
      seen.add(iri.get(i));
      problems.check(name.get(i) && Math.abs(lat[i]) <= 90 && Math.abs(lon[i]) <= 180, `stations[${i}] has no name or invalid coordinates`);
    }
    if (stopEnrichment) {
      // Every stop whose station is curated carries that station's names; none of them may be empty.
      const station = column(stopEnrichment, 'stationIri'); const fr = column(stopEnrichment, 'nameFr');
      for (let i = 0; i < stopEnrichment.numRows; i++) if (seen.has(station.get(i)) && !fr.get(i)) { problems.add(`stopEnrichment[${i}] lacks a name although its station is curated`); break; }
    }
  }
  for (const [name, state] of Object.entries(extensions.capabilities ?? {})) {
    if (state === 'available' && !(name in definitions && extensions.files?.[name])) {
      if (name in definitions) problems.add(`capability ${name} is available but no file is cataloged`);
    }
  }
  return finish(problems, report);
}

function finish(problems, report) {
  report.problems = problems.count ?? 0;
  if (problems.count) {
    const error = new Error(`Release ${report.releaseId} is invalid (${problems.count} problems):\n- ${problems.list.slice(0, 25).join('\n- ')}`);
    error.problems = problems.list;
    throw error;
  }
  return report;
}

/** Validates discovery (root manifest = latest release) and every release listed in releases/index.json. */
export async function validateSite(siteDir, { prefix = '', deepRelease, shallowOthers = true } = {}) {
  prefix = normalizePrefix(prefix);
  const root = await readJson(path.join(siteDir, RELEASE_MANIFEST));
  const releaseIds = (await readdir(path.join(siteDir, 'releases'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (!releaseIds.includes(root.releaseId)) throw new Error(`Discovery points to a missing release: ${root.releaseId}`);
  const reports = [];
  for (const id of releaseIds) {
    const deep = deepRelease ? id === deepRelease : (id === root.releaseId || !shallowOthers);
    reports.push(await validateRelease(siteDir, id, { prefix, deep }));
  }
  const released = await readJson(path.join(siteDir, 'releases', root.releaseId, RELEASE_MANIFEST));
  const { '@id': rootId, ...rootRest } = root;
  const { '@id': releaseId, ...releaseRest } = released;
  if (JSON.stringify(rootRest) !== JSON.stringify(releaseRest)) throw new Error('Discovery manifest differs from the immutable release manifest');
  if (rootId !== `${prefix}/${RELEASE_MANIFEST}` || !releaseId.endsWith(`/${root.releaseId}/${RELEASE_MANIFEST}`)) throw new Error('Unexpected manifest @id');
  await stat(path.join(siteDir, '.nojekyll')).catch(() => { throw new Error('.nojekyll is missing'); });
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const directory = args.find((arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1]?.startsWith('--') !== true);
  if (!directory) { console.error('usage: validate-release.mjs <siteDir> [--prefix /path] [--release id]'); process.exit(2); }
  const prefix = option('--prefix', '');
  const reports = option('--release') ? [await validateRelease(directory, option('--release'), { prefix })] : await validateSite(directory, { prefix });
  console.log(JSON.stringify(reports, null, 2));
}

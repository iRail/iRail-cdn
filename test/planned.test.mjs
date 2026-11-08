// Offline end-to-end checks for planned publication: real gtfs2lc conversion of a redistributable fixture,
// release validation, Pages-site assembly/retention and an independent reader over a local static server.
// No Worker, Wrangler, Cloudflare credential or upstream network access is used.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tableFromIPC } from 'apache-arrow';
import { earliestArrival, readTimetable } from '../examples/plan.mjs';
import { assemblePages } from '../scripts/assemble-pages.mjs';
import { buildSncb } from '../scripts/build-sncb.mjs';
import { checkPages } from '../scripts/check-pages.mjs';
import { RELEASE_EXTENSIONS, RELEASE_MANIFEST } from '../scripts/lib/release.mjs';
import { readJson, sha256, walk } from '../scripts/lib/util.mjs';
import { restorePages } from '../scripts/restore-pages.mjs';
import { serveSite } from '../scripts/serve-site.mjs';
import { validateRelease, validateSite } from '../scripts/validate-release.mjs';

const root = path.resolve(import.meta.dirname, '..');
const converterDir = path.resolve(process.env.GTFS2LC_DIR ?? path.join(root, '..', 'gtfs2lc'));
const available = existsSync(path.join(converterDir, 'bin', 'gtfs2lc.js')) && existsSync(path.join(converterDir, 'node_modules'));
if (!available && process.env.REQUIRE_CONVERTER) throw new Error(`gtfs2lc is required but missing at ${converterDir}`);
const skip = available ? false : `gtfs2lc checkout not found at ${converterDir}; set GTFS2LC_DIR`;
const work = path.join(root, 'build', 'test');
const PROJECT = '/iRail-cdn';
const stationsDir = path.join(root, 'fixtures', 'sncb', 'stations');
const common = { converterDir, stationsDir, allowUnpinnedStations: true, startDate: '20261024', endDate: '20261111', regions: 1, allowUnpinned: process.env.GTFS2LC_ALLOW_UNPINNED === '1' };

async function stage(name, { prefix = PROJECT, today = '20261109', gtfs = 'fixtures/sncb/gtfs', ...extra } = {}) {
  const directory = path.join(work, name);
  await rm(directory, { recursive: true, force: true });
  await cp(path.join(root, gtfs), path.join(directory, 'gtfs'), { recursive: true }); // the converter normalizes its input in place
  const result = await buildSncb({ ...common, prefix, today, gtfsDir: path.join(directory, 'gtfs'), stagingDir: path.join(directory, 'staging'), workDir: path.join(directory, 'work'), ...extra });
  return { ...result, staging: path.join(directory, 'staging'), directory };
}
const load = async (directory, relative) => tableFromIPC(await readFile(path.join(directory, relative)));
const releaseFile = (id, name) => `releases/${id}/${name}`;
const rows = (table) => [...table].map((row) => row.toJSON());
const treeHash = async (directory) => sha256(Buffer.from(JSON.stringify(await Promise.all((await walk(directory)).map(async (file) => [file, sha256(await readFile(path.join(directory, file)))])))));

let a; let b; let siteA; let siteB;

test('fixture GTFS converts through the pinned gtfs2lc into a validated release', { skip }, async () => {
  a = await stage('a', { today: '20261109' });
  assert.equal(a.status, 'built');
  assert.match(a.releaseId, /^sncb-20261109-[0-9a-f]{8}$/);
  assert.equal(a.rows.connections, 19);
  assert.equal(a.rows.stops, 5, 'one core stop per station');
  assert.equal(a.rows.platforms, 4);
  assert.equal(a.rows.trips, 7);
  assert.equal(a.rows.transfers, 4);
  assert.equal(a.rows.stations, 6, 'five curated stations plus one feed stop the curated list lacks');
  const manifest = await readJson(path.join(a.staging, 'manifest.jsonld'));
  assert.equal(manifest['@id'], `${PROJECT}/manifest.jsonld`);
  assert.equal(manifest.realtime, undefined, 'no provider live link until the live resources exist');
  assert.equal(manifest.stops, `${PROJECT}/releases/${a.releaseId}/stops.arrow`);
  assert.equal(manifest['irail:extensions']['@id'], `${PROJECT}/releases/${a.releaseId}/irail.json`);
  assert.equal(JSON.stringify(manifest).includes('"files"'), false);
  const extensions = await readJson(path.join(a.staging, releaseFile(a.releaseId, RELEASE_EXTENSIONS)));
  assert.equal(extensions.capabilities.occupancy, 'unavailable');
  assert.equal(extensions.capabilities.realtime, 'unconfigured');
  assert.equal(extensions.capabilities.shapes, 'unavailable');
  assert.equal(extensions.capabilities.stations, 'available');
  assert.equal(extensions.capabilities.headsigns, 'available');
  assert.deepEqual(extensions.diagnostics.headsigns, { distinct: 4, translated: { nl: 2, de: 1, en: 1 }, sourceLanguage: 'fr' });
  assert.deepEqual(extensions.sources.map((source) => source.id), ['gtfs-static', 'irail-stations']);
  assert.equal(extensions.sources[1].license, 'https://creativecommons.org/publicdomain/zero/1.0/');
  assert.deepEqual(extensions.diagnostics.stations, { curated: 5, matchedInGtfs: 4, curatedNotInGtfs: 1, addedFromGtfs: 1, skippedWithoutCoordinates: 0 });
  assert.deepEqual(extensions.diagnostics.stopReduction, { stations: 5, droppedParents: 4, platforms: 4, remappedTransfers: 2 });
  assert.equal(extensions.capabilities.platforms, 'available');
  assert.deepEqual(extensions.diagnostics.unsupportedGtfs, { frequencies: 0, pathways: 0 });
  assert.equal(extensions.sources[0].converter.commit, extensions.sources[0].converter.pinnedCommit);
  assert.equal(extensions.files.connections.length, manifest.connections.pages.length);
});

test('canonical iRail IRIs: a station is one stop, platforms hang off it by hash, runs and connections stay unique', { skip }, async () => {
  const dir = a.staging;
  const stops = await load(dir, releaseFile(a.releaseId, 'stops.arrow'));
  const stopIris = [...stops.getChild('iri').toArray()];
  assert.deepEqual(stopIris.sort(), ['http://irail.be/stations/NMBS/007099001', 'http://irail.be/stations/NMBS/008899001', 'http://irail.be/stations/NMBS/008899002', 'http://irail.be/stations/NMBS/008899003', 'http://irail.be/stations/NMBS/008899004']);
  assert.ok([...stops.getChild('parentIdx').toArray()].every((parent) => parent === -1), 'no parent stations or platform rows in the core');
  const stopExtra = rows(await load(dir, releaseFile(a.releaseId, 'stop-enrichment.arrow')));
  const alpha = stopExtra.find((row) => row.stopId === '8899001');
  assert.equal(alpha.iri, 'http://irail.be/stations/NMBS/008899001');
  assert.equal(alpha.stationIri, alpha.iri, 'the stop is the station');
  assert.equal(alpha.stationId, '008899001');
  assert.equal(alpha.hafasId, '8899001');
  assert.equal(alpha.platformCode, null);
  assert.equal(alpha.parentIri, null);
  assert.equal(alpha.nameNl, 'Fixture Alfa');
  assert.equal(alpha.nameFr, 'Fixture Alpha', 'an empty alternative means the neutral name applies');
  assert.equal(alpha.nameDe, 'Fixture Alpha Hbf');
  assert.equal(alpha.nameEn, 'Fixture Alpha Central');
  assert.equal(alpha.tafTapCode, 'BE99001');
  assert.equal(alpha.telegraphCode, 'FXA');
  assert.equal(alpha.officialTransferTime, 300);
  assert.equal(alpha.avgStopTimes, 120.5);
  assert.equal(alpha.countryCode, 'BE');
  const abroad = stopExtra.find((row) => row.stopId === '7099001');
  assert.equal(abroad.iri, 'http://irail.be/stations/NMBS/007099001');
  assert.equal(abroad.countryCode, 'GB');
  const platforms = rows(await load(dir, releaseFile(a.releaseId, 'platforms.arrow')));
  assert.deepEqual(platforms.map((row) => row.iri), [
    'http://irail.be/stations/NMBS/008899001#1', 'http://irail.be/stations/NMBS/008899001#2',
    'http://irail.be/stations/NMBS/008899002#1', 'http://irail.be/stations/NMBS/008899002#2']);
  const first = platforms[0];
  assert.equal(first.stationIri, alpha.iri);
  assert.equal(first.stopId, '8899001_1');
  assert.equal(first.platformCode, '1');
  assert.equal(stops.getChild('iri').get(first.stopIdx), first.stationIri, 'platforms join to the core station row');
  const curated = rows(await load(dir, releaseFile(a.releaseId, 'stations.arrow')));
  assert.equal(curated.length, 6);
  assert.deepEqual(curated.map((row) => row.source).sort(), ['gtfs', 'irail-stations', 'irail-stations', 'irail-stations', 'irail-stations', 'irail-stations']);
  // A feed stop without a curated entry is added with whatever the feed can say about it.
  const added = curated.find((row) => row.iri === abroad.iri);
  assert.deepEqual({ ...added, avgStopTimes: undefined }, {
    iri: 'http://irail.be/stations/NMBS/007099001', name: 'Fixture Abroad (GB)', alternativeFr: null, alternativeNl: null, alternativeDe: null, alternativeEn: null,
    tafTapCode: null, telegraphCode: null, countryCode: 'GB', lat: 51.53, lon: -0.12, avgStopTimes: undefined, officialTransferTime: null, source: 'gtfs' });
  assert.equal(added.avgStopTimes, 0.25, 'one run on one of the four service days of the release');
  assert.equal(abroad.nameFr, 'Fixture Abroad (GB)');
  assert.equal(abroad.avgStopTimes, 0.25);
  const curatedAlpha = curated.find((row) => row.iri === alpha.iri);
  assert.deepEqual([curatedAlpha.name, curatedAlpha.alternativeFr, curatedAlpha.alternativeNl, curatedAlpha.alternativeDe, curatedAlpha.alternativeEn], ['Fixture Alpha', null, 'Fixture Alfa', 'Fixture Alpha Hbf', 'Fixture Alpha Central']);
  assert.ok(curated.some((row) => row.iri.endsWith('008899099')), 'curated stations outside the feed are published too');
  const headsigns = rows(await load(dir, releaseFile(a.releaseId, 'headsigns.arrow')));
  assert.deepEqual(headsigns.map((row) => row.headsign), ['Abroad', 'Bravo', 'Charlie', 'Delta']);
  const charlie = headsigns.find((row) => row.headsign === 'Charlie');
  assert.deepEqual([charlie.translationNl, charlie.translationDe, charlie.translationEn], ['Charlie NL', 'Charlie / Charlie DE', 'Charlie EN']);
  const bravo = headsigns.find((row) => row.headsign === 'Bravo');
  assert.deepEqual([bravo.translationNl, bravo.translationDe, bravo.translationEn], ['Bravo NL', null, null], 'untranslated languages stay null');
  const tripExtra = rows(await load(dir, releaseFile(a.releaseId, 'trip-enrichment.arrow')));
  const ic1000 = tripExtra.filter((row) => row.vehicleIri === 'http://irail.be/vehicle/IC1000');
  assert.equal(ic1000.length, 2, 'two scheduled trips share one vehicle number');
  assert.notEqual(ic1000[0].iri, ic1000[1].iri);
  assert.ok(ic1000.every((row) => row.iri.startsWith('https://irail.be/id/be.sncb/trips/88____%3A04')));
  const iris = [...(await load(dir, releaseFile(a.releaseId, 'connections/0/2026-11-09T06/00000.arrow'))).getChild('iri').toArray()];
  assert.ok(iris.length > 0 && new Set(iris).size === iris.length);
  assert.ok(iris.every((iri) => /^https:\/\/irail\.be\/id\/be\.sncb\/runs\/.+\/20261109\/connections\/\d+$/.test(iri)));
});

test('DST fall-back, after-midnight times, linked transfers and pickup/drop-off survive conversion', { skip }, async () => {
  const dir = a.staging;
  const trips = rows(await load(dir, releaseFile(a.releaseId, 'trips.arrow')));
  const night = trips.findIndex((trip) => trip.shortName === '2000');
  const manifest = await readJson(path.join(dir, releaseFile(a.releaseId, RELEASE_MANIFEST)));
  const rowsOf = [];
  for (const page of manifest.connections.pages) {
    const table = await load(dir, `releases/${a.releaseId}/${page['@id'].slice(`${PROJECT}/releases/${a.releaseId}/`.length)}`);
    const epoch = Number(table.schema.metadata.get('epochSeconds'));
    for (const row of table) rowsOf.push({ ...row.toJSON(), departure: epoch + row.departureTimeOffset, arrival: epoch + row.arrivalTimeOffset });
  }
  const dst = rowsOf.find((row) => row.tripIdx === night && row.serviceDate === 20261024);
  assert.equal(dst.departure, Date.parse('2026-10-24T21:30:00Z') / 1000);
  assert.equal(dst.arrival - dst.departure, 4 * 3600, 'GTFS times count from noon minus twelve hours across the clock change');
  assert.equal(new Date(dst.arrival * 1000).toISOString(), '2026-10-25T01:30:00.000Z');
  const through = rowsOf.find((row) => trips[row.tripIdx].shortName === '1000' && row.serviceDate === 20261109).tripIdx;
  const first = rowsOf.filter((row) => row.tripIdx === through && row.serviceDate === 20261109).sort((x, y) => x.departure - y.departure);
  assert.equal(first[0].pickupType, 0);
  assert.equal(first[0].dropOffType, 0);
  assert.equal(first[0].arrivalStopSequence, first[1].stopSequence, 'adjacent call-to-call connections');
  const transfers = rows(await load(dir, releaseFile(a.releaseId, 'transfers.arrow')));
  const linked = transfers.filter((row) => row.transferType >= 4);
  assert.deepEqual(linked.map((row) => row.transferType).sort(), [4, 5]);
  const type4 = linked.find((row) => row.transferType === 4);
  assert.equal(type4.fromStopIdx, null);
  assert.equal(type4.toStopIdx, null);
  assert.notEqual(type4.fromTripIdx, null);
  assert.notEqual(linked.find((row) => row.transferType === 5).fromStopIdx, null);
});

test('the curated stations source is optional, pinned and strictly parsed', { skip }, async () => {
  const without = await stage('no-stations', { stationsDir: undefined });
  const extensions = await readJson(path.join(without.staging, releaseFile(without.releaseId, RELEASE_EXTENSIONS)));
  assert.equal(extensions.capabilities.stations, 'unavailable');
  assert.equal(extensions.files.stations, undefined);
  assert.deepEqual(extensions.sources.map((source) => source.id), ['gtfs-static']);
  assert.notEqual(without.releaseId, a.releaseId);
  const stopRow = rows(await load(without.staging, releaseFile(without.releaseId, 'stop-enrichment.arrow'))).find((row) => row.stopId === '8899001');
  assert.equal(stopRow.nameNl, 'Fixture Alfa', 'GTFS translations still apply without the curated source');
  assert.equal(stopRow.tafTapCode, null);
  // Only the pinned commit is accepted for production builds.
  await assert.rejects(stage('unpinned', { allowUnpinnedStations: false, allowUnpinned: false, stationsDir }), /expected pinned commit|gtfs2lc at/);
  const broken = path.join(work, 'broken-stations');
  await rm(broken, { recursive: true, force: true });
  await cp(stationsDir, broken, { recursive: true });
  await writeFile(path.join(broken, 'stations.csv'), (await readFile(path.join(broken, 'stations.csv'), 'utf8')).replace('4.3,50.8', '4.3,north'));
  await assert.rejects(stage('broken', { stationsDir: broken }), /invalid latitude/);
  assert.equal(existsSync(path.join(work, 'broken', 'staging', 'manifest.jsonld')), false);
});

test('the live GTFS-RT feed is linked from the manifest only when enabled, with a verified trip template', { skip }, async () => {
  const feed = { '@id': 'https://cdn.routableconnections.com/realtime/gtfs-rt/trip-updates.pb', '@type': 'GtfsRealtimeFeed', tripTemplate: 'https://irail.be/id/be.sncb/trips/{trip_id}' };
  const without = await readJson(path.join(a.staging, 'manifest.jsonld'));
  assert.equal(without.realtime, undefined);
  assert.equal((await readJson(path.join(a.staging, releaseFile(a.releaseId, RELEASE_EXTENSIONS)))).capabilities.realtime, 'unconfigured');
  const linked = await stage('realtime', { realtime: [feed] });
  const manifest = await readJson(path.join(linked.staging, 'manifest.jsonld'));
  assert.deepEqual(manifest.realtime, [feed]);
  const extensions = await readJson(path.join(linked.staging, releaseFile(linked.releaseId, RELEASE_EXTENSIONS)));
  assert.equal(extensions.capabilities.realtime, 'available');
  assert.equal(extensions.sources.find((source) => source.id === 'gtfs-rt').feeds[0], feed['@id']);
  assert.notEqual(linked.releaseId, a.releaseId, 'advertising a feed is a different release');
  // Every trip id of the feed must expand to the release's trip IRI, or the build fails instead of advertising a broken link.
  await assert.rejects(stage('realtime-bad', { realtime: [{ ...feed, tripTemplate: 'https://irail.be/id/be.sncb/other/{trip_id}' }] }), /does not reproduce trip IRI/);
});

test('unsupported GTFS features are rejected rather than silently dropped', { skip }, async () => {
  const directory = path.join(work, 'frequencies');
  await rm(directory, { recursive: true, force: true });
  await cp(path.join(root, 'fixtures/sncb/gtfs'), path.join(directory, 'gtfs'), { recursive: true });
  await writeFile(path.join(directory, 'gtfs', 'frequencies.txt'), 'trip_id,start_time,end_time,headway_secs\n88____:046::8899001:8899003:2:1000:20261231,08:00:00,09:00:00,600\n');
  await assert.rejects(buildSncb({ ...common, prefix: PROJECT, today: '20261109', gtfsDir: path.join(directory, 'gtfs'), stagingDir: path.join(directory, 'staging'), workDir: path.join(directory, 'work') }), /Unsupported GTFS feature: frequencies\.txt/);
  assert.equal(existsSync(path.join(directory, 'staging', 'manifest.jsonld')), false, 'a failed conversion must not leave a discovery document');
});

test('Pages assembly retains earlier immutable releases byte for byte and replaces discovery last', { skip }, async () => {
  siteA = path.join(work, 'site-a');
  const first = await assemblePages({ stagingDir: a.staging, outDir: siteA, prefix: PROJECT });
  assert.deepEqual(first.kept, [a.releaseId]);
  assert.equal((await readJson(path.join(siteA, 'manifest.jsonld'))).releaseId, a.releaseId);
  assert.equal(existsSync(path.join(siteA, '.nojekyll')), true);
  assert.match(await readFile(path.join(siteA, 'index.html'), 'utf8'), /manifest\.jsonld/);

  b = await stage('b', { today: '20261110', startDate: '20261025', endDate: '20261111' });
  assert.notEqual(b.releaseId, a.releaseId);
  siteB = path.join(work, 'site-b');
  const second = await assemblePages({ stagingDir: b.staging, previousDir: siteA, outDir: siteB, prefix: PROJECT });
  assert.deepEqual(second.kept, [b.releaseId, a.releaseId]);
  assert.equal((await readJson(path.join(siteB, 'manifest.jsonld'))).releaseId, b.releaseId);
  assert.equal(await treeHash(path.join(siteB, 'releases', a.releaseId)), await treeHash(path.join(siteA, 'releases', a.releaseId)), 'retained release bytes are unchanged');
  const index = await readJson(path.join(siteB, 'releases', 'index.json'));
  assert.deepEqual(index.releases.map((release) => release.releaseId), [b.releaseId, a.releaseId]);
  assert.equal(index.latest, b.releaseId);
  const reports = await validateSite(siteB, { prefix: PROJECT, shallowOthers: false });
  assert.equal(reports.length, 2);
  // A third release under a one-release retention limit drops the oldest instead of failing.
  const limited = await assemblePages({ stagingDir: b.staging, previousDir: siteA, outDir: path.join(work, 'site-limited'), prefix: PROJECT, maxReleases: 1 });
  assert.deepEqual(limited.kept, [b.releaseId]);
  assert.deepEqual(limited.dropped, [a.releaseId]);
});

test('failed, oversized, mutated and conflicting builds leave the last good site untouched', { skip }, async () => {
  const before = await treeHash(siteB);
  await assert.rejects(assemblePages({ stagingDir: b.staging, previousDir: siteA, outDir: siteB, prefix: PROJECT, maxSiteBytes: 1000 }), /does not fit/);
  assert.equal(await treeHash(siteB), before, 'oversized candidate keeps the previous site');
  assert.equal(existsSync(`${siteB}.assembling`), false);

  // A retained release whose bytes no longer match its catalog is never republished.
  const tampered = path.join(work, 'previous-tampered');
  await rm(tampered, { recursive: true, force: true });
  await cp(siteA, tampered, { recursive: true });
  const stopsFile = path.join(tampered, releaseFile(a.releaseId, 'stops.arrow'));
  const bytes = await readFile(stopsFile);
  bytes[bytes.length - 20] ^= 0xff;
  await writeFile(stopsFile, bytes);
  await assert.rejects(assemblePages({ stagingDir: b.staging, previousDir: tampered, outDir: path.join(work, 'site-tampered'), prefix: PROJECT }), /sha256 differs/);
  assert.equal(existsSync(path.join(work, 'site-tampered')), false);

  // Rebuilding an already published release id yields different bytes (generatedAt) and must not replace it.
  const again = await stage('again', { today: '20261109', releaseId: a.releaseId });
  await assert.rejects(assemblePages({ stagingDir: again.staging, previousDir: siteA, outDir: path.join(work, 'site-again'), prefix: PROJECT }), /immutable releases cannot be replaced/);
  // Identical inputs already published are reported as unchanged and skip the conversion.
  const unchanged = await buildSncb({ ...common, prefix: PROJECT, today: '20261109', gtfsDir: path.join(work, 'a', 'gtfs'), stagingDir: path.join(work, 'unchanged'), previousDir: siteA });
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.releaseId, a.releaseId, 'the release id is a function of the inputs and the pipeline code');
});

test('validation rejects malformed references, schemas and catalog drift', { skip }, async () => {
  const copy = path.join(work, 'invalid');
  const mutate = async (change) => {
    await rm(copy, { recursive: true, force: true });
    await cp(a.staging, copy, { recursive: true });
    await change(copy);
    return validateRelease(copy, a.releaseId, { prefix: PROJECT, deep: true });
  };
  const manifestPath = (dir) => path.join(dir, releaseFile(a.releaseId, RELEASE_MANIFEST));
  await assert.rejects(mutate(async (dir) => { const m = await readJson(manifestPath(dir)); m.stops = { '@id': m.stops }; await writeFile(manifestPath(dir), JSON.stringify(m)); }), /stops must be an IRI string/);
  await assert.rejects(mutate(async (dir) => { const m = await readJson(manifestPath(dir)); m.trips = '/elsewhere/trips.arrow'; await writeFile(manifestPath(dir), JSON.stringify(m)); }), /not under the public prefix|trips/);
  await assert.rejects(mutate(async (dir) => { const m = await readJson(manifestPath(dir)); m.schemaVersion = '1'; await writeFile(manifestPath(dir), JSON.stringify(m)); }), /schemaVersion must be 2-alpha/);
  await assert.rejects(mutate(async (dir) => { const m = await readJson(manifestPath(dir)); m.connections.pages[0]['@id'] += 'x'; await writeFile(manifestPath(dir), JSON.stringify(m)); }), /page file is missing/);
  await assert.rejects(mutate(async (dir) => { await writeFile(path.join(dir, releaseFile(a.releaseId, 'calls.arrow')), 'x'); }), /unexpected release file/);
  await assert.rejects(mutate(async (dir) => { const e = await readJson(path.join(dir, releaseFile(a.releaseId, RELEASE_EXTENSIONS))); e.files.stops.rowCount += 1; await writeFile(path.join(dir, releaseFile(a.releaseId, RELEASE_EXTENSIONS)), JSON.stringify(e)); }), /row count differs/);
  await assert.rejects(mutate(async (dir) => { const file = path.join(dir, releaseFile(a.releaseId, 'routes.arrow')); const bytes = await readFile(file); await writeFile(file, bytes.subarray(0, bytes.length - 3)); }), /catalog|ARROW1|sha256/);
});

async function withServer(directory, prefix, body) {
  const requested = [];
  const server = await serveSite(directory, { prefix, onRequest: (request) => requested.push(request.url) });
  try { await body(server.origin, requested); } finally { await server.close(); }
}

test('an independent core-only reader plans from static files at a project path without an iRail dependency', { skip }, async () => {
  await withServer(siteB, PROJECT, async (origin, requested) => {
    const { manifest, stops, connections, trips } = await readTimetable(`${origin}${PROJECT}/`);
    assert.equal(manifest.releaseId, b.releaseId);
    const stopIdx = (suffix) => stops.findIndex((stop) => stop.iri === `http://irail.be/stations/NMBS/00${suffix}`);
    // At 08:00 Brussels the through train departs Alpha and arrives at Charlie at 08:25 (07:25 UTC).
    const result = earliestArrival(connections, stops, stopIdx('8899001'), stopIdx('8899003'), Date.parse('2026-11-09T07:00:00Z') / 1000);
    assert.equal(new Date(result.time * 1000).toISOString(), '2026-11-09T07:25:00.000Z');
    assert.equal(trips[connections.find((connection) => connection.arrival === result.time).tripIdx].shortName, '1000');
    assert.ok(requested.every((url) => !url.includes('irail.json') && !url.includes('calls')));
    assert.ok(requested.every((url) => url.startsWith(PROJECT)));
    assert.equal(manifest.connections.pages.length, requested.filter((url) => url.includes('/connections/')).length);
  });
  // The retained release is still addressable after the newer deployment.
  await withServer(siteB, PROJECT, async (origin) => {
    const retained = await (await fetch(`${origin}${PROJECT}/releases/${a.releaseId}/manifest.jsonld`)).json();
    assert.equal(retained.releaseId, a.releaseId);
    const table = tableFromIPC(await (await fetch(new URL(retained.stops, `${origin}${PROJECT}/releases/${a.releaseId}/manifest.jsonld`))).arrayBuffer());
    assert.equal(table.schema.metadata.get('releaseId'), a.releaseId);
  });
});

test('domain-root hosting uses the same bytes layout and prefix-free IRIs', { skip }, async () => {
  const root1 = await stage('root', { prefix: '', today: '20261109' });
  const site = path.join(work, 'site-root');
  await assemblePages({ stagingDir: root1.staging, outDir: site, prefix: '' });
  await withServer(site, '', async (origin) => {
    const { manifest, connections, stops } = await readTimetable(`${origin}/`);
    assert.equal(manifest['@id'], '/manifest.jsonld');
    assert.equal(manifest.stops, `/releases/${root1.releaseId}/stops.arrow`);
    assert.equal(connections.length, 19);
    assert.equal(stops.length, 5);
  });
  const projectStops = await load(a.staging, releaseFile(a.releaseId, 'stops.arrow'));
  const rootStops = await load(site, releaseFile(root1.releaseId, 'stops.arrow'));
  assert.deepEqual([...rootStops.getChild('iri').toArray()], [...projectStops.getChild('iri').toArray()], 'entity IRIs do not depend on the delivery path');
});

test('a mixed-release query is rejected and malformed discovery fails the reader', { skip }, async () => {
  await withServer(siteB, PROJECT, async (origin) => {
    const staleStops = await readFile(path.join(siteB, releaseFile(a.releaseId, 'stops.arrow')));
    const mixed = async (input, init) => {
      const url = new URL(input);
      if (url.pathname === `${PROJECT}/releases/${b.releaseId}/stops.arrow`) return new Response(staleStops);
      return fetch(input, init);
    };
    await assert.rejects(readTimetable(`${origin}${PROJECT}/`, mixed), /Release mismatch/);
    const malformed = async (input, init) => {
      const url = new URL(input);
      if (url.pathname === `${PROJECT}/manifest.jsonld`) {
        const manifest = await (await fetch(input, init)).json();
        return Response.json({ ...manifest, stops: { '@id': manifest.stops } });
      }
      return fetch(input, init);
    };
    await assert.rejects(readTimetable(`${origin}${PROJECT}/`, malformed), /Expected stops IRI/);
  });
});

test('previous releases are restored from the deployed site with hash verification', { skip }, async () => {
  await withServer(siteB, PROJECT, async (origin) => {
    const restored = path.join(work, 'restored');
    await rm(restored, { recursive: true, force: true });
    const result = await restorePages({ baseUrl: `${origin}${PROJECT}`, outDir: restored });
    assert.equal(result.status, 'restored');
    assert.deepEqual(result.releases, [b.releaseId, a.releaseId]);
    assert.equal(await treeHash(path.join(restored, 'releases', a.releaseId)), await treeHash(path.join(siteB, 'releases', a.releaseId)));
    // Restored bytes can be re-published unchanged.
    const again = await assemblePages({ stagingDir: stagingFor(await stage('c', { today: '20261111', startDate: '20261026' })), previousDir: restored, outDir: path.join(work, 'site-c'), prefix: PROJECT, maxReleases: 3 });
    assert.equal(again.kept.length, 3);
    const empty = await restorePages({ baseUrl: `${origin}/nothing-here`, outDir: path.join(work, 'restored-empty') });
    assert.equal(empty.status, 'empty');
  });
  const tamperedFetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith('/trips.arrow')) return new Response(Buffer.concat([Buffer.from(await response.arrayBuffer()), Buffer.from('!')]));
    return response;
  };
  await withServer(siteB, PROJECT, async (origin) => {
    await assert.rejects(restorePages({ baseUrl: `${origin}${PROJECT}`, outDir: path.join(work, 'restored-bad'), fetcher: tamperedFetch }), /differs from its recorded hash/);
  });
  const outage = async () => new Response('unavailable', { status: 503 });
  await assert.rejects(restorePages({ baseUrl: 'https://pages.invalid/x', outDir: path.join(work, 'restored-down'), fetcher: outage }), /Cannot fetch/);
});
const stagingFor = (result) => result.staging;

test('the HTTP acceptance checker reports pass/warn/fail without hiding gaps', { skip }, async () => {
  await withServer(siteB, PROJECT, async (origin) => {
    const results = await checkPages(`${origin}${PROJECT}/`, { sample: 3 });
    assert.ok(results.length > 20);
    assert.deepEqual(results.filter((result) => result.severity === 'fail'), []);
    assert.ok(results.some((result) => result.severity === 'warn' && /caching|revalidation/.test(result.name)), 'a static preview does not set cache headers, which stays visible');
  });
  const plain = await serveSite(siteB, { prefix: PROJECT, cors: false });
  try {
    const results = await checkPages(`${plain.origin}${PROJECT}/`, { sample: 1 });
    assert.ok(results.some((result) => result.severity === 'fail' && /CORS/.test(result.name)));
  } finally { await plain.close(); }
});

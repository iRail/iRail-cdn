import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { tableFromIPC } from 'apache-arrow';
import { fixtureRoot, encodeRows, extensionProperty } from '../scripts/build-fixtures.mjs';
import { definitions, coreDefinitions, extensionVersion, schemaFor } from '../specs/schemas.mjs';
import { earliestArrival, planDemo } from '../examples/plan.mjs';
import { createIriStrategy } from '../src/identifiers.ts';

const manifest = JSON.parse(await readFile(`${fixtureRoot}manifest.jsonld`, 'utf8'));
const extensions = JSON.parse(await readFile(`${fixtureRoot}${manifest[extensionProperty]['@id'].slice(1)}`, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const load = descriptor => readFile(`${fixtureRoot}${(typeof descriptor === 'string' ? descriptor : descriptor.path).slice(1)}`);

test('LC core is pinned to the reviewed specification and has no calls contract', async () => {
  const pin = JSON.parse(await readFile(new URL('../config/lc-contract.json', import.meta.url)));
  assert.equal(pin.schemaVersion, '2-alpha');
  for (const artifact of Object.values(pin.artifacts)) {
    assert.equal(sha256(await readFile(new URL(`../${artifact.path}`, import.meta.url))), artifact.sha256);
  }
  assert.deepEqual(Object.keys(coreDefinitions), ['connections', 'stops', 'trips', 'routes', 'transfers']);
  assert.equal(coreDefinitions.connections.length, 11);
  assert.equal(coreDefinitions.stops.at(-1).name, 'regionIri');
  assert.equal(definitions.calls, undefined);
  assert.equal(definitions.planning, undefined);
  assert.throws(() => schemaFor('calls'), /Unknown dataset/);
  assert.throws(() => schemaFor('connections', { schemaVersion: '1' }), /Invalid.*metadata/);
  assert.throws(() => schemaFor('connections', { dataset: 'planning' }), /Invalid.*metadata/);
});

test('LC discovery uses IRI table links and keeps integrity and capabilities in the iRail extension', async () => {
  assert.equal(manifest['@type'], 'Timetable');
  assert.equal(manifest.schemaVersion, '2-alpha');
  for (const name of ['stops', 'trips', 'routes', 'transfers']) assert.equal(typeof manifest[name], 'string');
  for (const name of ['format', 'version', 'files', 'status', 'calls', 'planning', 'sha256', 'rowCount', 'byteLength', 'mediaType']) assert.equal(manifest[name], undefined);
  const page = manifest.connections.pages[0];
  for (const name of ['sha256', 'rowCount', 'byteLength', 'mediaType']) assert.equal(page[name], undefined);
  assert.equal(typeof page['@id'], 'string');
  assert.equal(extensions.releaseId, manifest.releaseId);
  assert.equal(extensions.version, extensionVersion);
  assert.equal(extensions.status, 'demo');
  assert.equal(extensions.capabilities.occupancy, 'unavailable');
  assert.equal(extensions.realtimeManifestPath, undefined);
  assert.deepEqual(JSON.parse(await load(manifest['@id'])), manifest);
  const paths = await readdir(`${fixtureRoot}releases/${manifest.releaseId}`);
  assert.ok(!paths.includes('calls.arrow') && !paths.includes('planning.arrow') && !paths.includes('manifest.json'));
});

test('IPC files match schemas, integrity catalog, release metadata, indices and temporal bounds', async () => {
  const descriptors = Object.entries(extensions.files).flatMap(([name, entry]) => (Array.isArray(entry) ? entry : [entry]).map(descriptor => [name, descriptor]));
  const tables = {};
  for (const [name, descriptor] of descriptors) {
    const bytes = await load(descriptor);
    assert.equal(bytes.subarray(0, 6).toString(), 'ARROW1');
    assert.equal(bytes.length, descriptor.byteLength);
    assert.equal(sha256(bytes), descriptor.sha256);
    const table = tableFromIPC(bytes);
    tables[name] = table;
    assert.equal(table.numRows, descriptor.rowCount);
    assert.deepEqual(table.schema.fields.map(f => [f.name, f.type.toString(), f.nullable]), schemaFor(name).fields.map(f => [f.name, f.type.toString(), f.nullable]));
    assert.equal(table.schema.metadata.get('releaseId'), manifest.releaseId);
    assert.equal(table.schema.metadata.get('dataset'), name);
    assert.equal(table.schema.metadata.get('schemaVersion'), Object.hasOwn(coreDefinitions, name) ? '2-alpha' : extensionVersion);
    if (Object.hasOwn(coreDefinitions, name)) {
      assert.deepEqual(table.schema.fields.map(f => ({ name: f.name, type: f.type.toString(), nullable: f.nullable })), coreDefinitions[name]);
      assert.equal(table.schema.metadata.get('format'), undefined);
    }
  }
  const page = manifest.connections.pages[0];
  const epoch = Number(tables.connections.schema.metadata.get('epochSeconds'));
  assert.equal(epoch, page.epochSeconds);
  assert.equal(tables.connections.schema.metadata.get('region'), page.region);
  let previous = -Infinity;
  const keys = new Set();
  for (const row of tables.connections) {
    const departure = epoch + row.departureTimeOffset;
    const arrival = epoch + row.arrivalTimeOffset;
    assert.ok(departure >= previous && arrival >= departure);
    previous = departure;
    assert.ok(row.arrivalStopSequence > row.stopSequence);
    for (const idx of [row.departureStopIdx, row.arrivalStopIdx]) assert.ok(idx >= 0 && idx < tables.stops.numRows);
    assert.ok(row.tripIdx >= 0 && row.tripIdx < tables.trips.numRows);
    assert.equal(tables.stops.get(row.departureStopIdx).regionIri, page.region);
    assert.ok(page.arrivalRegions.includes(tables.stops.get(row.arrivalStopIdx).regionIri));
    const key = `${row.tripIdx}/${row.serviceDate}/${row.stopSequence}`;
    assert.ok(!keys.has(key));
    keys.add(key);
    const extra = [...tables.connectionEnrichment].find(extra => extra.iri === row.iri);
    assert.equal(extra.tripIri, tables.trips.get(row.tripIdx).iri);
    assert.equal(extra.departureStopIri, tables.stops.get(row.departureStopIdx).iri);
    assert.equal(extra.arrivalStopIri, tables.stops.get(row.arrivalStopIdx).iri);
  }
  assert.equal(Date.parse(page.minDepartureTime) / 1000, epoch + tables.connections.getChild('departureTimeOffset').get(0));
  assert.equal(Date.parse(page.maxDepartureTime) / 1000, previous);
  // Both sides of an intermediate event, plus terminal arrival, survive without a calls table.
  const [first, next] = [...tables.connections];
  assert.equal(first.arrivalStopSequence, next.stopSequence);
  assert.equal(first.arrivalStopIdx, next.departureStopIdx);
  assert.equal(next.departureTimeOffset - first.arrivalTimeOffset, 120);
  assert.equal(epoch + next.arrivalTimeOffset, Date.parse('2026-11-07T08:23:00Z') / 1000);
  const [firstExtra, nextExtra] = [...tables.connectionEnrichment];
  assert.equal(firstExtra.arrivalCallIri, nextExtra.departureCallIri);
  for (const [extraName, coreName, index] of [['stopEnrichment', 'stops', 'stopIdx'], ['tripEnrichment', 'trips', 'tripIdx'], ['routeEnrichment', 'routes', 'routeIdx']]) {
    for (const row of tables[extraName]) assert.equal(row.iri, tables[coreName].get(row[index]).iri);
  }
  assert.equal(tables.stopEnrichment.get(0).stopId, 'demo:A');
  const shape = tables.shapes.get(tables.tripEnrichment.get(0).shapeIdx);
  const points = tableFromIPC(await load(shape.path));
  assert.equal(points.numRows, shape.pointCount);
  assert.equal(points.schema.metadata.get('dataset'), 'shapePoints');
  const strategyBytes = await load(extensions.identityStrategy);
  assert.equal(strategyBytes.length, extensions.identityStrategy.byteLength);
  assert.equal(sha256(strategyBytes), extensions.identityStrategy.sha256);
  const rules = JSON.parse(strategyBytes);
  const strategy = createIriStrategy(extensions.sourceId, { ...rules, sources: {} });
  assert.equal(strategy.mint('stop', { stops: { key: 'A' } }, ['A']), tables.stops.get(0).iri);
  assert.equal(rules.identityProfile, extensions.identityProfile);
});

test('nullable linked-trip endpoints and every extension retain typed IPC schemas', () => {
  const linked = tableFromIPC(encodeRows('transfers', [{ transferType: 4, fromTripIdx: 0, toTripIdx: 1 }]));
  assert.equal(linked.get(0).fromStopIdx, null);
  assert.equal(linked.get(0).toStopIdx, null);
  assert.equal(linked.get(0).fromTripIdx, 0);
  for (const name of Object.keys(definitions)) {
    const table = tableFromIPC(encodeRows(name, []));
    assert.equal(table.numRows, 0);
    assert.equal(table.schema.fields.length, definitions[name].length);
  }
});

function fixtureFetcher(basePath = '/', replacement) {
  return async input => {
    const url = new URL(input);
    assert.ok(url.pathname.startsWith(basePath));
    const path = url.pathname.slice(basePath.length);
    if (replacement) {
      const response = replacement(path);
      if (response) return response;
    }
    if (path === 'manifest.jsonld' && basePath !== '/') {
      const relative = structuredClone(manifest);
      for (const key of ['stops', 'trips', 'routes', 'transfers']) relative[key] = relative[key].slice(1);
      for (const page of relative.connections.pages) page['@id'] = page['@id'].slice(1);
      return Response.json(relative);
    }
    return new Response(await readFile(`${fixtureRoot}${path}`));
  };
}

test('plain LC reader plans from core files at root and project paths without an extension or calls dependency', async () => {
  for (const prefix of ['/', '/project/']) {
    const requested = [];
    const fetcher = fixtureFetcher(prefix);
    const result = await planDemo(`https://pages.test${prefix}`, url => { requested.push(new URL(url).pathname); return fetcher(url); });
    assert.deepEqual(result, { arrival: '2026-11-07T08:23:00.000Z', stops: ['Demo A', 'Demo B', 'Demo C'] });
    assert.equal(requested.length, 3);
    assert.ok(requested.every(path => !path.includes('irail.json') && !path.includes('calls')));
  }
});

test('plain LC reader rejects old manifests, descriptor table links and mixed-release IPC', async () => {
  for (const invalid of [{ ...manifest, schemaVersion: '1' }, { ...manifest, stops: { '@id': manifest.stops } }]) {
    await assert.rejects(planDemo('https://pages.test', fixtureFetcher('/', path => path === 'manifest.jsonld' ? Response.json(invalid) : undefined)), /Unsupported LC|Expected stops IRI/);
  }
  const wrongRelease = encodeRows('stops', [], { releaseId: 'other-release' });
  await assert.rejects(planDemo('https://pages.test', fixtureFetcher('/', path => path === manifest.stops.slice(1) ? new Response(wrongRelease) : undefined)), /Release mismatch/);
});

test('scan preserves dated through rides and enforces transfers and boarding restrictions', () => {
  const stops = [{ minTransferTime: 0 }, { minTransferTime: 300 }, { minTransferTime: 0 }];
  const c = (overrides) => ({ departureStopIdx: 0, arrivalStopIdx: 1, departure: 100, arrival: 200, tripIdx: 0, serviceDate: 20261107, stopSequence: 10, arrivalStopSequence: 20, pickupType: 0, dropOffType: 0, ...overrides });
  const first = c({});
  const next = c({ departureStopIdx: 1, arrivalStopIdx: 2, departure: 210, arrival: 300, stopSequence: 20, arrivalStopSequence: 30 });
  assert.equal(earliestArrival([first, next], stops, 0, 2, 100).time, 300);
  assert.equal(earliestArrival([first, { ...next, tripIdx: 1 }], stops, 0, 2, 100), null);
  assert.equal(earliestArrival([first, { ...next, serviceDate: 20261108 }], stops, 0, 2, 100), null);
  assert.equal(earliestArrival([{ ...first, pickupType: 1 }, next], stops, 0, 2, 100), null);
  assert.equal(earliestArrival([first, { ...next, dropOffType: 1 }], stops, 0, 2, 100), null);
});

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RecordBatch, Struct, Table, makeData, tableToIPC, vectorFromArray } from 'apache-arrow';
import { definitions, coreDefinitions, extensionVersion, schemaFor } from '../specs/schemas.mjs';
import { identifiers } from '../src/identifiers.ts';

export const fixtureRoot = fileURLToPath(new URL('../dist/fixtures/', import.meta.url));
export const releaseId = 'demo-lc2-alpha';
const ids = identifiers('demo.fixture');
export const epochSeconds = Date.parse('2026-11-07T06:00:00Z') / 1000;
const region = ids.entity('regions', 'all');
const releasePath = `/releases/${releaseId}`;
export const extensionProperty = 'irail:extensions';

const data = {
  stops: ['A', 'B', 'C'].map((name, i) => ({
    name: `Demo ${name}`, lat: 50.8 + i * 0.02, lon: 4.3 + i * 0.02,
    parentIdx: -1, iri: ids.stop(name), minTransferTime: 120, regionIri: region,
  })),
  routes: [{ shortName: 'DEMO', iri: ids.route('rail'), routeType: 2 }],
  trips: ['through', 'shuttle'].map((id) => ({ iri: ids.trip(id), routeIdx: 0, headsign: 'Demo C', shortName: id })),
  connections: [
    { departureStopIdx: 0, arrivalStopIdx: 1, departureTimeOffset: 7200, arrivalTimeOffset: 7800, tripIdx: 0, stopSequence: 10, arrivalStopSequence: 20 },
    { departureStopIdx: 1, arrivalStopIdx: 2, departureTimeOffset: 7920, arrivalTimeOffset: 8580, tripIdx: 0, stopSequence: 20, arrivalStopSequence: 30 },
    { departureStopIdx: 1, arrivalStopIdx: 2, departureTimeOffset: 8100, arrivalTimeOffset: 8700, tripIdx: 1, stopSequence: 5, arrivalStopSequence: 9 },
  ].map((row) => ({
    pickupType: 0, dropOffType: 0, serviceDate: 20261107, ...row,
    iri: ids.connection(['through', 'shuttle'][row.tripIdx], 20261107, row.stopSequence),
  })),
  transfers: [{ fromStopIdx: 1, toStopIdx: 1, transferType: 2, minTransferTime: 120 }],
  stopEnrichment: ['A', 'B', 'C'].map((name, stopIdx) => ({ stopIdx, stopId: `demo:${name}`, regionIdx: 0, iri: ids.stop(name), stationIri: ids.stop(name) })),
  tripEnrichment: ['through', 'shuttle'].map((key, tripIdx) => ({ tripIdx, tripId: `demo:${key}`, iri: ids.trip(key), routeIri: ids.route('rail'), vehicleIri: ids.entity('vehicles', key), shapeIdx: 0, shapeIri: ids.shape('line'), geometryIdx: -1 })),
  routeEnrichment: [{ routeIdx: 0, routeId: 'demo:rail', iri: ids.route('rail'), agencyId: 'demo', agencyIri: ids.agency('demo') }],
  transferEnrichment: [{ transferIdx: 0, iri: ids.entity('transfers', 'B/B'), fromStopIri: ids.stop('B'), toStopIri: ids.stop('B') }],
  shapes: [{ shapeId: 'demo:line', iri: ids.shape('line'), path: `${releasePath}/shapes/demo.arrow`, pointCount: 3 }],
  shapePoints: [0, 1, 2].map((i) => ({ iri: ids.entity('shape-points', `line/${i + 1}`), shapeIri: ids.shape('line'), sequence: i + 1, lat: 50.8 + i * 0.02, lon: 4.3 + i * 0.02 })),
};
data.connectionEnrichment = data.connections.map((connection) => {
  const key = data.trips[connection.tripIdx].shortName;
  return {
    iri: connection.iri, tripIri: data.trips[connection.tripIdx].iri, runIri: ids.run(key, connection.serviceDate),
    departureStopIri: data.stops[connection.departureStopIdx].iri, arrivalStopIri: data.stops[connection.arrivalStopIdx].iri,
    departureCallIri: ids.call(key, connection.serviceDate, connection.stopSequence), arrivalCallIri: ids.call(key, connection.serviceDate, connection.arrivalStopSequence),
  };
});

export function encodeRows(name, rows, metadata = {}) {
  const schema = schemaFor(name, { releaseId, ...metadata });
  const children = schema.fields.map((field) => vectorFromArray(rows.map((row) => {
    const value = row[field.name] ?? null;
    if (value === null && !field.nullable) throw new Error(`${name}.${field.name} cannot be null`);
    return value;
  }), field.type).data[0]);
  const batch = new RecordBatch(schema, makeData({ type: new Struct(schema.fields), length: rows.length, children }));
  return tableToIPC(new Table(batch), 'file');
}

export async function buildFixtures() {
  // This directory contains generated fixtures only. Remove obsolete schema files.
  await rm(fixtureRoot, { recursive: true, force: true });
  const directory = `${fixtureRoot}releases/${releaseId}`;
  await mkdir(`${directory}/shapes`, { recursive: true });
  const files = {};
  for (const name of Object.keys(definitions)) {
    if (['delaysCancellations', 'stopStatus'].includes(name)) continue;
    const rows = data[name] || [];
    const metadata = name === 'connections' ? { epochSeconds: String(epochSeconds), region } : {};
    const bytes = encodeRows(name, rows, metadata);
    const filename = name === 'shapePoints' ? 'shapes/demo.arrow' : `${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}.arrow`;
    await writeFile(`${directory}/${filename}`, bytes);
    const descriptor = {
      path: `${releasePath}/${filename}`, rowCount: rows.length, byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/vnd.apache.arrow.file',
    };
    files[name] = name === 'connections' ? [descriptor] : descriptor;
  }
  const extensions = {
    format: 'irail-cdn-extensions', version: extensionVersion, status: 'demo', sourceId: ids.snapshot.sourceId,
    identityProfile: ids.snapshot.identityProfile, identityBase: ids.snapshot.identityBase,
    releaseId, generatedAt: '2026-11-07T06:00:00Z',
    sources: [{ id: 'fixture', description: 'Synthetic test data; no SNCB observations', license: 'https://creativecommons.org/publicdomain/zero/1.0/' }],
    serviceDates: { start: 20261107, end: 20261107 },
    partitioning: { timePartitionSeconds: 21600, maxRows: 50000, regions: [{ iri: region }] },
    capabilities: { connections: 'demo', realtime: 'unconfigured', compositions: 'unavailable', occupancy: 'unavailable', alerts: 'unavailable' },
    files,
  };
  const strategyBytes = `${JSON.stringify(ids.snapshot, null, 2)}\n`;
  await writeFile(`${directory}/identity-strategy.json`, strategyBytes);
  extensions.identityStrategy = {
    path: `${releasePath}/identity-strategy.json`, byteLength: Buffer.byteLength(strategyBytes),
    sha256: createHash('sha256').update(strategyBytes).digest('hex'), mediaType: 'application/json',
  };
  await writeFile(`${directory}/irail.json`, `${JSON.stringify(extensions, null, 2)}\n`);
  const manifest = {
    '@context': ['https://linkedconnections.org/specification/2-0-alpha/context.jsonld', { irail: 'https://irail.be/vocab/' }],
    '@id': `${releasePath}/manifest.jsonld`, '@type': 'Timetable', schemaVersion: '2-alpha', releaseId,
    generatedAt: '2026-11-07T06:00:00Z', timeZone: 'Europe/Brussels',
    license: 'https://creativecommons.org/publicdomain/zero/1.0/', rights: 'Synthetic test data; no SNCB observations',
    coverageStart: '2026-11-07T08:00:00Z', coverageEnd: '2026-11-07T08:25:01Z',
    ...Object.fromEntries(Object.keys(coreDefinitions).filter(name => name !== 'connections').map(name => [name, files[name].path])),
    connections: {
      '@type': 'ConnectionCollection', pages: [{
        '@id': files.connections[0].path, epochSeconds, region, arrivalRegions: [region],
        minDepartureTime: '2026-11-07T08:00:00Z', maxDepartureTime: '2026-11-07T08:15:00Z',
      }],
    },
    [extensionProperty]: { '@id': `${releasePath}/irail.json` },
  };
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(`${directory}/manifest.jsonld`, json);
  await writeFile(`${fixtureRoot}manifest.jsonld`, json);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildFixtures();
  console.log(`Synthetic LC2-alpha Arrow release written to ${fixtureRoot}`);
}

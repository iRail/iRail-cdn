import { pathToFileURL } from 'node:url';
import { tableFromIPC } from 'apache-arrow';
import coreSchemas from '../specs/lc-core-schemas.json' with { type: 'json' };

// Educational static CSA for the fixture: no walking, real-time or specific transfer selectors.
export function earliestArrival(connections, stops, origin, destination, departureTime) {
  const best = new Map([[origin, { time: departureTime, path: [] }]]);
  const aboard = new Map();
  for (const connection of [...connections].sort((a, b) => a.departure - b.departure)) {
    const run = `${connection.tripIdx}/${connection.serviceDate}`;
    const continued = aboard.get(run);
    let path = continued?.sequence === connection.stopSequence ? continued.path : null;
    const access = best.get(connection.departureStopIdx);
    const buffer = access?.path.length ? stops[connection.departureStopIdx].minTransferTime : 0;
    if (connection.pickupType === 0 && access && access.time + buffer <= connection.departure) {
      path ??= access.path;
    }
    if (!path) continue;
    const next = [...path, connection];
    aboard.set(run, { sequence: connection.arrivalStopSequence, path: next });
    if (connection.dropOffType === 0 && connection.arrival < (best.get(connection.arrivalStopIdx)?.time ?? Infinity)) {
      best.set(connection.arrivalStopIdx, { time: connection.arrival, path: next });
    }
  }
  return best.get(destination) ?? null;
}

/**
 * Independent core-only reader: follows IRI strings from `manifest.jsonld` (resolved against the manifest
 * URL, so root and project-path hosting both work), checks every table's metadata and pinned schema, and
 * restarts nothing silently: a table from another release is an error the caller must answer with a new query.
 */
export async function readTimetable(base = 'http://localhost:8787', fetcher = fetch, dictionaries = ['stops', 'trips', 'routes', 'transfers']) {
  const manifestUrl = new URL('manifest.jsonld', base.endsWith('/') ? base : `${base}/`);
  const response = await fetcher(manifestUrl);
  if (!response.ok) throw new Error(`Manifest returned HTTP ${response.status}; run npm run seed first`);
  const manifest = await response.json();
  if (manifest.schemaVersion !== '2-alpha' || manifest['@type'] !== 'Timetable' || !manifest.releaseId) {
    throw new Error('Unsupported LC manifest');
  }
  const documentUrl = response.url || manifestUrl;
  async function load(iri, dataset) {
    if (typeof iri !== 'string') throw new Error(`Expected ${dataset} IRI`);
    const res = await fetcher(new URL(iri, documentUrl));
    if (!res.ok) throw new Error(`Dataset returned HTTP ${res.status}`);
    const table = tableFromIPC(await res.arrayBuffer());
    if (table.schema.metadata.get('releaseId') !== manifest.releaseId) throw new Error('Release mismatch; restart the query with a new manifest');
    if (table.schema.metadata.get('schemaVersion') !== '2-alpha' || table.schema.metadata.get('dataset') !== dataset) throw new Error('Unsupported LC table metadata');
    for (const expected of coreSchemas[dataset]) {
      const actual = table.schema.fields.find(field => field.name === expected.name);
      if (!actual || actual.type.toString() !== expected.type || actual.nullable !== expected.nullable) throw new Error(`Invalid ${dataset}.${expected.name} schema`);
    }
    return table;
  }
  const stops = [...await load(manifest.stops, 'stops')].map(row => row.toJSON());
  const optional = async (name) => (dictionaries.includes(name) ? [...await load(manifest[name], name)].map(row => row.toJSON()) : []);
  const [trips, routes, transfers] = [await optional('trips'), await optional('routes'), await optional('transfers')];
  const connections = [];
  for (const page of manifest.connections.pages) {
    const table = await load(page['@id'], 'connections');
    const epoch = Number(table.schema.metadata.get('epochSeconds'));
    if (!Number.isSafeInteger(epoch) || (page.epochSeconds !== undefined && page.epochSeconds !== epoch)) throw new Error('Invalid page epoch');
    for (const row of table) {
      connections.push({ ...row.toJSON(), departure: epoch + row.departureTimeOffset, arrival: epoch + row.arrivalTimeOffset });
    }
  }
  return { manifest, stops, trips, routes, transfers, connections };
}

export async function planDemo(base = 'http://localhost:8787', fetcher = fetch) {
  const { stops, connections } = await readTimetable(base, fetcher, ['stops']);
  const from = stops.findIndex((stop) => stop.name === 'Demo A');
  const to = stops.findIndex((stop) => stop.name === 'Demo C');
  if (from < 0 || to < 0) throw new Error('This example requires the synthetic Demo A/C stops');
  const result = earliestArrival(connections, stops, from, to, Date.parse('2026-11-07T08:00:00Z') / 1000);
  if (!result) throw new Error('No route found');
  return { arrival: new Date(result.time * 1000).toISOString(), stops: [stops[from].name, ...result.path.map((c) => stops[c.arrivalStopIdx].name)] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await planDemo(process.argv[2]);
  console.log(`${result.stops.join(' → ')}; arrives ${result.arrival}`);
}

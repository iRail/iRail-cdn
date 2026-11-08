// Reduces the SNCB stop hierarchy to what the routing core needs: one stop per station.
//
// The feed has three kinds of stop rows: `S<uic>` parent stations (location_type 1), `<uic>` station-level stops
// (the only ones stop_times and transfers use) and `<uic>_<platform>` platform stops. Keeping all three in the LC
// stops table would give every station three identifiers. Instead the disposable GTFS copy keeps only the
// station-level stop (its IRI is the iRail station IRI) and the platforms are published separately as
// `platforms.arrow`, identified as <station IRI>#<platform code>. The archive itself is never modified.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

const PLATFORM_ID = /^(\d{7})_(.+)$/u;
const STATION_ID = /^\d{7}$/u;

const read = async (directory, name) => {
  const records = parse(await readFile(path.join(directory, name), 'utf8'), { bom: true, skip_empty_lines: true, relax_column_count: true });
  const columns = records[0];
  return { columns, rows: records.slice(1).map((record) => Object.fromEntries(columns.map((column, i) => [column, record[i] ?? '']))) };
};
const write = (directory, name, columns, rows) => writeFile(path.join(directory, name), stringify(rows, { header: true, columns }));

/**
 * Rewrites stops.txt and transfers.txt in `gtfsDir` (an extracted copy) and returns the removed platforms.
 * Throws when the feed does not have the expected shape, so a changed source can never silently change identities.
 */
export async function reduceToStations(gtfsDir) {
  const { rows: stops, columns } = await read(gtfsDir, 'stops.txt');
  const byId = new Map(stops.map((stop) => [stop.stop_id, stop]));
  const parents = new Map();
  const platforms = [];
  const stations = [];
  for (const stop of stops) {
    const type = stop.location_type || '0';
    if (type === '1') { parents.set(stop.stop_id, stop); continue; }
    const platform = PLATFORM_ID.exec(stop.stop_id);
    if (type === '0' && platform) {
      const station = byId.get(platform[1]);
      if (!station || PLATFORM_ID.test(station.stop_id) || (station.location_type || '0') !== '0') throw new Error(`Platform stop ${stop.stop_id} has no station-level stop ${platform[1]}`);
      platforms.push({
        stopId: stop.stop_id, stationStopId: platform[1], platformCode: stop.platform_code || platform[2],
        lat: stop.stop_lat === '' ? null : Number(stop.stop_lat), lon: stop.stop_lon === '' ? null : Number(stop.stop_lon),
        wheelchairBoarding: stop.wheelchair_boarding === '' || stop.wheelchair_boarding === undefined ? null : Number(stop.wheelchair_boarding),
      });
      continue;
    }
    stations.push(stop);
  }
  for (const stop of stations) {
    if (!STATION_ID.test(stop.stop_id)) throw new Error(`Unexpected stop id ${stop.stop_id}: SNCB station-level stops have seven digits`);
    if (stop.parent_station && !parents.has(stop.parent_station)) throw new Error(`Stop ${stop.stop_id} has an unexpected parent ${stop.parent_station}`);
    stop.parent_station = '';
  }
  if (!stations.length) throw new Error('No station-level stops left after reduction');
  await write(gtfsDir, 'stops.txt', columns, stations);

  const platformIds = new Set(platforms.map((platform) => platform.stopId));
  // Transfers must reference remaining stops; platform-level and parent-level selectors collapse to their station.
  let remapped = 0;
  const transfersText = await readFile(path.join(gtfsDir, 'transfers.txt'), 'utf8').catch(() => null);
  if (transfersText !== null) {
    const { rows, columns: transferColumns } = await read(gtfsDir, 'transfers.txt');
    const stationOf = (id) => {
      if (!id) return id;
      if (parents.has(id)) return id.replace(/^S/u, '');
      return platformIds.has(id) ? PLATFORM_ID.exec(id)[1] : id;
    };
    const merged = new Map();
    for (const row of rows) {
      const next = { ...row, from_stop_id: stationOf(row.from_stop_id), to_stop_id: stationOf(row.to_stop_id) };
      if (next.from_stop_id !== row.from_stop_id || next.to_stop_id !== row.to_stop_id) remapped++;
      const key = JSON.stringify(['from_stop_id', 'to_stop_id', 'transfer_type', 'from_route_id', 'to_route_id', 'from_trip_id', 'to_trip_id'].map((name) => next[name] ?? ''));
      const existing = merged.get(key);
      if (!existing) merged.set(key, next);
      else if (Number(next.min_transfer_time || 0) > Number(existing.min_transfer_time || 0)) merged.set(key, next); // the longest buffer is the safe one
    }
    await write(gtfsDir, 'transfers.txt', transferColumns, [...merged.values()]);
  }
  platforms.sort((a, b) => (a.stopId < b.stopId ? -1 : 1));
  return { platforms, dropped: { parents: parents.size, platforms: platforms.length }, stations: stations.length, remappedTransfers: remapped };
}

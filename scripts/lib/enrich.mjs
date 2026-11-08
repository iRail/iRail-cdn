// Static iRail enrichment tables for a converted release. They are built from the same GTFS files that
// gtfs2lc read and join to the converter's dictionaries through the canonical IRIs, so they never alter
// core bytes or re-run calendar/connection expansion.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { tableFromIPC } from 'apache-arrow';
import { createIriStrategy, IriRegistry } from '../../src/iri-strategy.ts';
import { encodeRows } from './arrow.mjs';
import { sha256 } from './util.mjs';

const NMBS_STOP_ID = /^(?:gs:nmbssncb:)?S?(\d{7})(?:_.*)?$/u; // the same pattern iRail uses (Stop.getHafasId)
const STATION_ROOT = /^(?:S|00)?(\d{7})$/u; // the converter's verified-station pattern
const UIC_COUNTRY = { 70: 'GB', 71: 'ES', 80: 'DE', 81: 'AT', 82: 'LU', 83: 'IT', 84: 'NL', 85: 'CH', 86: 'DK', 87: 'FR', 88: 'BE' };

async function csv(gtfsDir, name, { optional = false } = {}) {
  let text;
  try { text = await readFile(path.join(gtfsDir, name), 'utf8'); } catch (error) {
    if (optional && error.code === 'ENOENT') return [];
    throw error;
  }
  return parse(text, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true });
}

const small = (value, max) => {
  if (value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) throw new Error(`Invalid enumeration value: ${value}`);
  return number;
};

function indexByIri(table, raw, mintFor, kind) {
  const byIri = new Map();
  for (const row of raw) {
    const iri = mintFor(row);
    if (byIri.has(iri)) throw new Error(`Two GTFS ${kind} rows mint ${iri}`);
    byIri.set(iri, row);
  }
  if (byIri.size !== table.numRows) throw new Error(`${kind}: ${table.numRows} converted rows but ${byIri.size} GTFS rows`);
  return byIri;
}

/**
 * @param {Array<object>} [platforms] platform stops removed from the core by scripts/lib/stops.mjs; published as `platforms.arrow`
 * @param {Array<object>} [stations] curated rows from scripts/lib/stations.mjs. They override GTFS names, codes and
 *   transfer data for every stop whose station IRI is one of them, and are published once more as `stations.arrow`.
 */
export async function buildEnrichment({ gtfsDir, releaseDir, releaseId, sourceId, strategyConfig, stations, platforms }) {
  const strategy = createIriStrategy(sourceId, strategyConfig, new IriRegistry());
  const { mint } = strategy;
  const read = async (name) => tableFromIPC(await readFile(path.join(releaseDir, `${name}.arrow`)));
  const [stopsTable, tripsTable, routesTable] = await Promise.all(['stops', 'trips', 'routes'].map(read));
  const [stopsRaw, routesRaw, tripsRaw, agencies, translations, feedInfo] = await Promise.all([
    csv(gtfsDir, 'stops.txt'), csv(gtfsDir, 'routes.txt'), csv(gtfsDir, 'trips.txt'), csv(gtfsDir, 'agency.txt'),
    csv(gtfsDir, 'translations.txt', { optional: true }), csv(gtfsDir, 'feed_info.txt', { optional: true }),
  ]);
  const defaultLanguage = (feedInfo[0]?.feed_lang || agencies[0]?.agency_lang || '').toLowerCase().slice(0, 2);

  const stopById = new Map(stopsRaw.map((stop) => [stop.stop_id, stop]));
  const stopMint = (stop) => mint('stop', { stops: { ...stop, key: stop.stop_id } }, [stop.stop_id]);
  const stopByIri = indexByIri(stopsTable, stopsRaw, stopMint, 'stop');
  const names = new Map();
  for (const row of translations) {
    if (row.table_name !== 'stops' || row.field_name !== 'stop_name') continue;
    const key = row.record_id || row.field_value;
    if (key) names.set(`${row.language.toLowerCase().slice(0, 2)}\u0000${row.record_id ? 'id' : 'name'}\u0000${key}`, row.translation);
  }
  const localized = (language, stop) => names.get(`${language}\u0000id\u0000${stop.stop_id}`) ?? names.get(`${language}\u0000name\u0000${stop.stop_name}`)
    ?? (language === defaultLanguage ? stop.stop_name : null) ?? null;

  const curated = new Map((stations ?? []).map((station) => [station.iri, station]));
  const matched = new Set();
  const stopRows = [];
  for (let stopIdx = 0; stopIdx < stopsTable.numRows; stopIdx++) {
    const core = stopsTable.get(stopIdx);
    const stop = stopByIri.get(core.iri);
    if (!stop) throw new Error(`stops row ${stopIdx} has no GTFS source row`);
    let root = stop;
    const seen = new Set();
    while (root.parent_station) {
      if (seen.has(root.stop_id)) throw new Error('Cyclic stop hierarchy');
      seen.add(root.stop_id);
      root = stopById.get(root.parent_station);
      if (!root) throw new Error(`Unknown parent station of ${stop.stop_id}`);
    }
    const verified = sourceId === 'be.sncb' && root.location_type === '1' ? STATION_ROOT.exec(root.stop_id) : null;
    const hafas = NMBS_STOP_ID.exec(stop.stop_id)?.[1] ?? null;
    const stationIri = verified ? mint('station', { stops: { ...root, key: verified[1], uic: verified[1] } }, [verified[1]]) : stopMint(root);
    const station = curated.get(stationIri);
    if (station) matched.add(stationIri);
    const neutral = (alternative) => (station ? alternative ?? station.name : null);
    stopRows.push({
      stopIdx, stopId: stop.stop_id, regionIdx: null,
      stationIri,
      stationId: hafas ? `00${hafas}` : null, hafasId: hafas,
      nameNl: neutral(station?.alternativeNl) ?? localized('nl', stop), nameFr: neutral(station?.alternativeFr) ?? localized('fr', stop),
      nameDe: neutral(station?.alternativeDe) ?? localized('de', stop), nameEn: neutral(station?.alternativeEn) ?? localized('en', stop),
      countryCode: station?.countryCode ?? (hafas ? UIC_COUNTRY[hafas.slice(0, 2)] ?? null : null),
      tafTapCode: station?.tafTapCode ?? null, telegraphCode: station?.telegraphCode ?? null,
      officialTransferTime: station?.officialTransferTime ?? null, avgStopTimes: station?.avgStopTimes ?? null,
      platformCode: stop.platform_code || null, wheelchairBoarding: small(stop.wheelchair_boarding, 2),
      iri: core.iri, parentIri: core.parentIdx >= 0 ? stopsTable.get(core.parentIdx).iri : null,
    });
  }

  const agencyById = new Map(agencies.map((agency) => [agency.agency_id || '', agency]));
  const agencyFor = (route) => agencyById.get(route.agency_id || '') ?? (agencies.length === 1 ? agencies[0] : null);
  const routeByIri = indexByIri(routesTable, routesRaw, (route) => mint('route', { routes: { ...route, key: route.route_id } }, [route.route_id]), 'route');
  const routeRows = [];
  for (let routeIdx = 0; routeIdx < routesTable.numRows; routeIdx++) {
    const core = routesTable.get(routeIdx);
    const route = routeByIri.get(core.iri);
    const agency = agencyFor(route);
    if (!agency) throw new Error(`Unknown agency for route ${route.route_id}`);
    const agencyId = agency.agency_id || 'default';
    routeRows.push({
      routeIdx, routeId: route.route_id, agencyId, product: route.route_short_name || null, iri: core.iri,
      agencyIri: mint('agency', { agency: { ...agency, key: agencyId } }, [agencyId]),
    });
  }

  const routeById = new Map(routesRaw.map((route) => [route.route_id, route]));
  const tripByIri = indexByIri(tripsTable, tripsRaw, (trip) => mint('trip', { trips: { ...trip, key: trip.trip_id }, routes: routeById.get(trip.route_id) }, [trip.trip_id]), 'trip');
  const tripRows = [];
  for (let tripIdx = 0; tripIdx < tripsTable.numRows; tripIdx++) {
    const core = tripsTable.get(tripIdx);
    const trip = tripByIri.get(core.iri);
    const route = routeById.get(trip.route_id);
    const vehicleId = trip.trip_short_name ? `${route.route_short_name ?? ''}${trip.trip_short_name}` : null;
    tripRows.push({
      tripIdx, tripId: trip.trip_id, vehicleIri: vehicleId ? mint('vehicle', { vehicle: { key: vehicleId }, routes: route, trips: trip }, [vehicleId]) : null,
      shapeIdx: -1, geometryIdx: -1, directionId: small(trip.direction_id, 1), blockId: trip.block_id || null,
      wheelchairAccessible: small(trip.wheelchair_accessible, 2), bikesAllowed: small(trip.bikes_allowed, 2),
      iri: core.iri, routeIri: routesTable.get(core.routeIdx).iri,
    });
  }

  // Headsign translations: GTFS keys them by the source-language text (field_value); per-trip record_id rows are not used.
  const headsignRows = new Map();
  const headsignTranslations = translations.filter((row) => row.table_name === 'trips' && row.field_name === 'trip_headsign' && !row.record_id);
  for (const trip of tripsRaw) if (trip.trip_headsign && !headsignRows.has(trip.trip_headsign)) headsignRows.set(trip.trip_headsign, { headsign: trip.trip_headsign, translationNl: null, translationDe: null, translationEn: null });
  const translated = { nl: 0, de: 0, en: 0 };
  for (const row of headsignTranslations) {
    const target = headsignRows.get(row.field_value);
    const language = row.language.toLowerCase().slice(0, 2);
    if (!target || !(language in translated) || !row.translation) continue;
    const field = `translation${language[0].toUpperCase()}${language[1]}`;
    if (target[field] === null) translated[language]++;
    target[field] = row.translation;
  }
  const headsigns = [...headsignRows.values()].sort((a, b) => (a.headsign < b.headsign ? -1 : 1));

  const stopIdxById = new Map(stopRows.map((row) => [row.stopId, row.stopIdx]));
  const platformRows = (platforms ?? []).map((platform) => {
    const stopIdx = stopIdxById.get(platform.stationStopId);
    if (stopIdx === undefined) throw new Error(`Platform ${platform.stopId} has no station ${platform.stationStopId} in the release`);
    const stationIri = stopRows[stopIdx].iri;
    return {
      stopIdx, stopId: platform.stopId, platformCode: platform.platformCode, lat: platform.lat, lon: platform.lon,
      wheelchairBoarding: platform.wheelchairBoarding, iri: `${stationIri}#${encodeURIComponent(platform.platformCode)}`, stationIri,
    };
  });
  if (new Set(platformRows.map((row) => row.iri)).size !== platformRows.length) throw new Error('Two platforms share an identifier');

  const metadata = { releaseId };
  const outputs = {};
  if (platformRows.length) {
    await writeFile(path.join(releaseDir, 'platforms.arrow'), encodeRows('platforms', platformRows, metadata));
    outputs.platforms = { file: 'platforms.arrow', rowCount: platformRows.length };
  }
  let headsignDiagnostics = null;
  if (headsignTranslations.length) {
    await writeFile(path.join(releaseDir, 'headsigns.arrow'), encodeRows('headsigns', headsigns, metadata));
    outputs.headsigns = { file: 'headsigns.arrow', rowCount: headsigns.length };
    headsignDiagnostics = { distinct: headsigns.length, translated, sourceLanguage: defaultLanguage || null };
  }
  let stationDiagnostics = null;
  if (stations) {
    await writeFile(path.join(releaseDir, 'stations.arrow'), encodeRows('stations', stations, metadata));
    outputs.stations = { file: 'stations.arrow', rowCount: stations.length };
    const gtfsStations = new Set(stopRows.filter((row) => row.stationIri.startsWith(strategy.snapshot.bases?.stations ?? '\u0000')).map((row) => row.stationIri));
    stationDiagnostics = {
      curated: stations.length, matchedInGtfs: matched.size, curatedNotInGtfs: stations.length - matched.size,
      gtfsStationsWithoutCuratedEntry: [...gtfsStations].filter((iri) => !curated.has(iri)).length,
    };
  }
  for (const [name, file, rows] of [['stopEnrichment', 'stop-enrichment.arrow', stopRows], ['tripEnrichment', 'trip-enrichment.arrow', tripRows], ['routeEnrichment', 'route-enrichment.arrow', routeRows]]) {
    await writeFile(path.join(releaseDir, file), encodeRows(name, rows, metadata));
    outputs[name] = { file, rowCount: rows.length };
  }
  const strategyBytes = `${JSON.stringify(strategy.snapshot, null, 2)}\n`;
  await writeFile(path.join(releaseDir, 'identity-strategy.json'), strategyBytes);
  return { outputs, strategy: strategy.snapshot, strategySha256: sha256(strategyBytes), stationDiagnostics, headsignDiagnostics };
}

// Curated station reference data from github.com/iRail/stations (CC0), pinned by commit.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'csv-parse/sync';
import { sha256 } from './util.mjs';

const exec = promisify(execFile);
const URI = /^http:\/\/irail\.be\/stations\/NMBS\/(\d{9})$/u;

export async function verifyStations(directory, pin, { allowUnpinned = false } = {}) {
  let commit = null;
  let dirty = false;
  try {
    commit = (await exec('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
    dirty = (await exec('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim() !== '';
  } catch { /* not a git checkout (fixtures) */ }
  const pinned = commit === pin.commit && !dirty;
  if (!pinned && !allowUnpinned) throw new Error(`iRail stations at ${directory} is ${commit ? `${commit}${dirty ? ' (modified)' : ''}` : 'not a git checkout'}, expected pinned commit ${pin.commit}`);
  return { commit, pinned };
}

const text = (value) => (value === undefined || value.trim() === '' ? null : value.trim());
const number = (value, label, row) => {
  const parsed = Number(value);
  if (value === '' || !Number.isFinite(parsed)) throw new Error(`stations.csv ${row}: invalid ${label} '${value}'`);
  return parsed;
};

/** Parses stations.csv; any malformed row fails the build instead of publishing partial reference data. */
export async function readStations(directory, pin) {
  const bytes = await readFile(path.join(directory, pin.file));
  const rows = parse(bytes, { columns: true, bom: true, skip_empty_lines: true });
  const seen = new Set();
  const stations = rows.map((row) => {
    const uri = row.URI;
    if (!URI.test(uri)) throw new Error(`stations.csv: unexpected station URI '${uri}'`);
    if (seen.has(uri)) throw new Error(`stations.csv: duplicate station ${uri}`);
    seen.add(uri);
    if (!text(row.name)) throw new Error(`stations.csv ${uri}: missing name`);
    const lat = number(row.latitude, 'latitude', uri);
    const lon = number(row.longitude, 'longitude', uri);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error(`stations.csv ${uri}: coordinates out of range`);
    const transfer = text(row.official_transfer_time);
    if (transfer !== null && !/^\d+$/u.test(transfer)) throw new Error(`stations.csv ${uri}: invalid official_transfer_time`);
    return {
      iri: uri, name: row.name.trim(),
      alternativeFr: text(row['alternative-fr']), alternativeNl: text(row['alternative-nl']),
      alternativeDe: text(row['alternative-de']), alternativeEn: text(row['alternative-en']),
      tafTapCode: text(row['taf-tap-code']), telegraphCode: text(row['telegraph-code']),
      countryCode: text(row['country-code'])?.toUpperCase() ?? null, lat, lon,
      avgStopTimes: text(row.avg_stop_times) === null ? null : number(row.avg_stop_times, 'avg_stop_times', uri),
      officialTransferTime: transfer === null ? null : Number(transfer),
    };
  });
  if (!stations.length) throw new Error('stations.csv has no stations');
  stations.sort((a, b) => (a.iri < b.iri ? -1 : 1));
  return { stations, sha256: sha256(bytes), byteLength: bytes.length };
}

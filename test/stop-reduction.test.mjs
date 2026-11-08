import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'csv-parse/sync';
import { reduceToStations } from '../scripts/lib/stops.mjs';

const root = path.resolve(import.meta.dirname, '..');
const work = path.join(root, 'build', 'test-stops');
const csv = async (directory, name) => parse(await readFile(path.join(directory, name), 'utf8'), { columns: true, bom: true });

async function copy(name) {
  const directory = path.join(work, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await cp(path.join(root, 'fixtures/sncb/gtfs'), directory, { recursive: true });
  return directory;
}

test('the stop hierarchy is reduced to one station-level stop per station and platforms are returned', async () => {
  const directory = await copy('ok');
  const result = await reduceToStations(directory);
  assert.deepEqual(result.dropped, { parents: 4, platforms: 4 });
  assert.equal(result.stations, 5);
  assert.deepEqual(result.platforms.map((platform) => [platform.stopId, platform.stationStopId, platform.platformCode]), [
    ['8899001_1', '8899001', '1'], ['8899001_2', '8899001', '2'], ['8899002_1', '8899002', '1'], ['8899002_2', '8899002', '2']]);
  const stops = await csv(directory, 'stops.txt');
  assert.deepEqual(stops.map((stop) => stop.stop_id).sort(), ['7099001', '8899001', '8899002', '8899003', '8899004']);
  assert.ok(stops.every((stop) => stop.parent_station === '' && stop.location_type === '0'));
  // Platform-level transfers collapse to their station; selectors and linked-trip rules are untouched.
  const transfers = await csv(directory, 'transfers.txt');
  assert.equal(result.remappedTransfers, 2);
  assert.deepEqual(transfers.filter((row) => row.transfer_type === '2').map((row) => [row.from_stop_id, row.to_stop_id, row.min_transfer_time]), [['8899002', '8899002', '300']]);
  assert.equal(transfers.filter((row) => row.transfer_type === '4')[0].from_stop_id, '');
  // Running it again is a no-op.
  assert.equal((await reduceToStations(directory)).platforms.length, 0);
});

test('conflicting platform transfers keep the longest buffer', async () => {
  const directory = await copy('merge');
  await writeFile(path.join(directory, 'transfers.txt'), 'from_stop_id,to_stop_id,transfer_type,min_transfer_time,from_route_id,to_route_id,from_trip_id,to_trip_id\n8899002_1,8899002_2,2,300,,,,\n8899002_2,8899002_1,2,420,,,,\nS8899002,S8899002,2,200,,,,\n');
  await reduceToStations(directory);
  assert.deepEqual((await csv(directory, 'transfers.txt')).map((row) => [row.from_stop_id, row.to_stop_id, row.min_transfer_time]), [['8899002', '8899002', '420']]);
});

test('an unexpected stop shape is an error instead of a silent identity change', async () => {
  const orphan = await copy('orphan');
  await writeFile(path.join(orphan, 'stops.txt'), `${await readFile(path.join(orphan, 'stops.txt'), 'utf8')}8899077_3,,Orphan,,50,4,,,0,S8899077,3,\n`);
  await assert.rejects(reduceToStations(orphan), /no station-level stop 8899077/);
  const odd = await copy('odd');
  await writeFile(path.join(odd, 'stops.txt'), `${await readFile(path.join(odd, 'stops.txt'), 'utf8')}ABC,,Odd,,50,4,,,0,,,\n`);
  await assert.rejects(reduceToStations(odd), /seven digits/);
});

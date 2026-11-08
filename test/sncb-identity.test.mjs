import assert from 'node:assert/strict';
import test from 'node:test';
import { createIriStrategy } from '../src/identifiers.ts';

test('be.sncb keeps the iRail API IRIs for stations and vehicles and a unique namespace for runs and connections', () => {
  const sncb = createIriStrategy('be.sncb');
  assert.equal(sncb.mint('station', { stops: { key: '8814001', uic: '8814001' } }, ['8814001']), 'http://irail.be/stations/NMBS/008814001');
  const context = { vehicle: { key: 'IC5130' }, routes: { route_short_name: 'IC' }, trips: { trip_short_name: '5130' } };
  assert.equal(sncb.mint('vehicle', context, ['IC5130']), 'http://irail.be/vehicle/IC5130');
  // Other sources get an ordinary namespaced vehicle IRI from the global template.
  assert.equal(createIriStrategy('nl.ns').mint('vehicle', { vehicle: { key: 'IC5130' } }, ['IC5130']), 'https://irail.be/id/nl.ns/vehicles/IC5130');
  // Several scheduled trips share a vehicle number on one day, so runs/connections must not use vehicle/date IRIs.
  const key = '88____:007::8814001:8896008:6:1015:20261211';
  const run = sncb.mint('run', { trips: { key }, connection: { serviceDate: '20261109' } }, [key, '20261109']);
  assert.equal(run, 'https://irail.be/id/be.sncb/runs/88____%3A007%3A%3A8814001%3A8896008%3A6%3A1015%3A20261211/20261109');
  assert.ok(sncb.snapshot.bases.stations.startsWith('http://irail.be/stations/NMBS'));
});

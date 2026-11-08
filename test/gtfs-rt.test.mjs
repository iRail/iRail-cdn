// Offline tests of the GTFS-RT publisher: fake R2 bucket and fake upstream, no Cloudflare, Wrangler or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import pkg from 'gtfs-realtime-bindings';
import { collectMinute, collectOnce, FEED_KEY, LATEST_KEY } from '../src/gtfs-rt/collect.ts';
import { readFeedHeader } from '../src/gtfs-rt/header.ts';
import worker from '../src/gtfs-rt/worker.ts';

const { FeedMessage } = pkg.transit_realtime;
const NOW = Date.parse('2026-11-08T13:47:30Z');
const TIMESTAMP = 1794145609; // 2026-11-08T13:46:49Z, as in the recorded upstream header below

function feed({ timestamp = TIMESTAMP, incrementality = 0, trips = 3, version = '1.0' } = {}) {
  return FeedMessage.encode(FeedMessage.fromObject({
    header: { gtfsRealtimeVersion: version, incrementality, timestamp },
    entity: Array.from({ length: trips }, (_, i) => ({
      id: `u${i}`,
      tripUpdate: {
        trip: { tripId: `88____:007::8200510:8814001:14:1442:2026110${i}`, startDate: '20261108', scheduleRelationship: i === 2 ? 3 : 0 },
        stopTimeUpdate: [{ stopId: '8866001_3', arrival: { delay: 60, time: TIMESTAMP + 600 + i }, departure: { delay: 120, time: TIMESTAMP + 700 + i } }],
      },
    })),
  })).finish();
}

class FakeBucket {
  objects = new Map();
  writes = [];
  async head(key) { const object = this.objects.get(key); return object ? { customMetadata: object.customMetadata, httpMetadata: object.httpMetadata } : null; }
  async put(key, value, options = {}) {
    this.writes.push(key);
    this.objects.set(key, { value: typeof value === 'string' ? new TextEncoder().encode(value) : value, ...options });
  }
  text(key) { return new TextDecoder().decode(this.objects.get(key).value); }
}

const respond = (bytes, init = {}) => () => Promise.resolve(new Response(bytes, { status: 200, headers: { 'content-length': String(bytes?.length ?? 0), ...init.headers }, ...init }));
const environment = (bucket = new FakeBucket(), extra = {}) => ({ DATA: bucket, GTFS_RT_URL: 'https://upstream.example/feed', PUBLIC_BASE_URL: 'https://cdn.example/', ...extra });
const deps = (fetcher) => ({ fetcher, now: () => NOW });

test('the header reader matches a recorded upstream header and the protobuf library', () => {
  // First bytes of a real SNCB snapshot taken on 8 November 2026 (header only, then an entity tag).
  const recorded = Uint8Array.from(Buffer.from('0a0d0a03312e30100018c9fac1d706', 'hex'));
  assert.deepEqual(readFeedHeader(recorded), { version: '1.0', incrementality: 0, timestamp: TIMESTAMP, entities: 0 });
  const bytes = feed({ trips: 5, version: '2.0' });
  const decoded = FeedMessage.decode(bytes);
  assert.deepEqual(readFeedHeader(bytes), { version: decoded.header.gtfsRealtimeVersion, incrementality: decoded.header.incrementality, timestamp: Number(decoded.header.timestamp), entities: decoded.entity.length });
  assert.equal(readFeedHeader(bytes).entities, 5);
});

test('malformed, truncated, headerless and unframed bodies are rejected', () => {
  const bytes = feed();
  assert.throws(() => readFeedHeader(bytes.subarray(0, bytes.length - 7)), /exceeds the message|Truncated/);
  assert.throws(() => readFeedHeader(new TextEncoder().encode('<html><body>Quota exceeded</body></html>')), /protobuf|header|wire type|exceeds/i);
  assert.throws(() => readFeedHeader(new Uint8Array()), /no header/);
  assert.throws(() => readFeedHeader(Uint8Array.from([0x12, 0x00])), /no header/);
  assert.throws(() => readFeedHeader(Uint8Array.from([0x0a, 0x02, 0x10, 0x00])), /version missing/);
  assert.throws(() => readFeedHeader(Uint8Array.from(Buffer.from('0a0a0a03312e30100018', 'hex'))), /Truncated|exceeds/);
});

test('a snapshot is published as the single latest version, protobuf first, with edge-cache headers', async () => {
  const bucket = new FakeBucket();
  const bytes = feed();
  const outcome = await collectOnce(environment(bucket), deps(respond(bytes)));
  assert.deepEqual(outcome, { status: 'published', timestamp: TIMESTAMP, byteLength: bytes.length, entities: 3 });
  assert.deepEqual(bucket.writes, [FEED_KEY, LATEST_KEY]);
  const stored = bucket.objects.get(FEED_KEY);
  assert.deepEqual(Buffer.from(stored.value), Buffer.from(bytes), 'upstream bytes are stored untouched');
  assert.equal(stored.httpMetadata.contentType, 'application/x-protobuf');
  assert.equal(stored.httpMetadata.cacheControl, 'public, max-age=15');
  assert.equal(stored.customMetadata.feedTimestamp, String(TIMESTAMP));
  const latest = JSON.parse(bucket.text(LATEST_KEY));
  assert.equal(latest.url, 'https://cdn.example/realtime/gtfs-rt/trip-updates.pb');
  assert.equal(latest.feedTimestamp, TIMESTAMP);
  assert.equal(latest.feedTime, '2026-11-08T13:46:49.000Z');
  assert.equal(latest.fetchedAt, '2026-11-08T13:47:30.000Z');
  assert.equal(latest.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(latest.byteLength, bytes.length);
  assert.equal(latest.retention, 'latest version only');
  assert.match(latest.attribution, /Belgian Mobility/);
  assert.equal(latest.license, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(bucket.objects.get(LATEST_KEY).httpMetadata.cacheControl, 'public, max-age=15');
  assert.deepEqual([...bucket.objects.keys()], [FEED_KEY, LATEST_KEY], 'no archive copies are kept');
});

test('an unchanged or older snapshot is not written; a newer one replaces the previous', async () => {
  const bucket = new FakeBucket();
  await collectOnce(environment(bucket), deps(respond(feed())));
  bucket.writes.length = 0;
  assert.deepEqual(await collectOnce(environment(bucket), deps(respond(feed()))), { status: 'unchanged', timestamp: TIMESTAMP });
  assert.deepEqual(await collectOnce(environment(bucket), deps(respond(feed({ timestamp: TIMESTAMP - 30 })))), { status: 'stale', timestamp: TIMESTAMP - 30, published: TIMESTAMP });
  assert.deepEqual(bucket.writes, []);
  const newer = await collectOnce(environment(bucket), deps(respond(feed({ timestamp: TIMESTAMP + 30, trips: 4 }))));
  assert.equal(newer.status, 'published');
  assert.equal(JSON.parse(bucket.text(LATEST_KEY)).feedTimestamp, TIMESTAMP + 30);
  assert.equal(JSON.parse(bucket.text(LATEST_KEY)).entities, 4);
});

test('every failure leaves the previously published feed untouched', async () => {
  const bucket = new FakeBucket();
  await collectOnce(environment(bucket), deps(respond(feed())));
  const before = [...bucket.objects].map(([key, object]) => [key, Buffer.from(object.value).toString('hex')]);
  bucket.writes.length = 0;
  const good = feed({ timestamp: TIMESTAMP + 30 });
  const failures = [
    [respond('quota', { status: 503 }), /HTTP 503/],
    [respond('', { status: 302, headers: { location: 'https://elsewhere.example/' } }), /HTTP 302/],
    [respond('<html>Quota Exceeded</html>'), /protobuf|header|wire type|exceeds/i],
    [respond(good.subarray(0, good.length - 5)), /incomplete|exceeds|Truncated/i], // content-length matches the cut body: framing check catches it
    [respond(good, { headers: { 'content-length': String(good.length + 10) } }), /incomplete/],
    [respond(feed({ timestamp: TIMESTAMP + 30, incrementality: 1 })), /Differential/],
    [respond(feed({ timestamp: Math.floor(NOW / 1000) + 3600 })), /future/],
    [respond(new Uint8Array(8 * 1024 * 1024 + 1)), /size limit/],
    [() => Promise.reject(new TypeError('network down')), /network down/],
  ];
  for (const [fetcher, pattern] of failures) await assert.rejects(collectOnce(environment(bucket), deps(fetcher)), pattern);
  assert.deepEqual(bucket.writes, []);
  assert.deepEqual([...bucket.objects].map(([key, object]) => [key, Buffer.from(object.value).toString('hex')]), before);
});

test('configuration: disabled without URL, HTTPS only, credential only when configured and never to redirects', async () => {
  const bucket = new FakeBucket();
  assert.deepEqual(await collectOnce(environment(bucket, { GTFS_RT_URL: '' }), deps(respond(feed()))), { status: 'disabled' });
  await assert.rejects(collectOnce(environment(bucket, { GTFS_RT_URL: 'http://upstream.example/feed' }), deps(respond(feed()))), /HTTPS/);
  const seen = [];
  const spy = (input, init) => { seen.push({ headers: Object.fromEntries(init.headers), redirect: init.redirect }); return respond(feed())(); };
  await collectOnce(environment(new FakeBucket()), deps(spy));
  assert.equal(seen[0].headers['x-rt-token'], undefined);
  assert.equal(seen[0].redirect, 'manual');
  await collectOnce(environment(new FakeBucket(), { GTFS_RT_TOKEN: 'secret', GTFS_RT_TOKEN_HEADER: 'bmc-partner-key' }), deps(spy));
  assert.equal(seen[1].headers['bmc-partner-key'], 'secret');
});

test('a cron run polls now and 30 seconds after its scheduled time; one failing poll does not block the other', async () => {
  const bucket = new FakeBucket();
  let clock = NOW;
  const sleeps = [];
  const timeline = [];
  const fetcher = () => { timeline.push(clock); return respond(feed({ timestamp: TIMESTAMP + timeline.length }))(); };
  const outcomes = await collectMinute(environment(bucket), NOW, { fetcher, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  assert.deepEqual(sleeps, [30_000]);
  assert.deepEqual(timeline, [NOW, NOW + 30_000]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['published', 'published']);

  // A late-starting run only waits for the remaining time, and never a negative or longer time.
  sleeps.length = 0;
  clock = NOW + 12_000;
  await collectMinute(environment(new FakeBucket()), NOW, { fetcher: respond(feed()), now: () => clock, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, [18_000]);
  sleeps.length = 0;
  clock = NOW + 45_000;
  await collectMinute(environment(new FakeBucket()), NOW, { fetcher: respond(feed()), now: () => clock, sleep: async (ms) => { sleeps.push(ms); } });
  assert.deepEqual(sleeps, []);

  let calls = 0;
  const flaky = () => (++calls === 1 ? Promise.reject(new Error('first poll failed')) : respond(feed())());
  const recovered = await collectMinute(environment(new FakeBucket()), NOW, { fetcher: flaky, now: () => NOW, sleep: async () => {} });
  assert.deepEqual(recovered.map((outcome) => outcome.status), ['published']);
  await assert.rejects(collectMinute(environment(new FakeBucket()), NOW, { fetcher: () => Promise.reject(new Error('upstream down')), now: () => NOW, sleep: async () => {} }), /upstream down/);
});

test('the Worker entry point is cron-only and runs a full minute', async () => {
  assert.equal(worker.fetch, undefined, 'no HTTP route: clients read the bucket through its custom domain');
  const bucket = new FakeBucket();
  const original = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  let upstream = 0;
  globalThis.fetch = () => { upstream++; return respond(feed({ timestamp: Math.floor(Date.now() / 1000) - 10 }))(); };
  globalThis.setTimeout = (callback) => realSetTimeout(callback, 0); // do not actually wait 30 s
  try {
    await worker.scheduled({ scheduledTime: Date.now() }, environment(bucket));
  } finally { globalThis.fetch = original; globalThis.setTimeout = realSetTimeout; }
  assert.equal(upstream, 2);
  assert.deepEqual(bucket.writes, [FEED_KEY, LATEST_KEY], 'the second poll saw an unchanged timestamp and wrote nothing');
});

test('the live checker reports pass, warn and fail for a served feed', async () => {
  const { checkRealtime } = await import('../scripts/check-realtime.mjs');
  const bucket = new FakeBucket();
  const bytes = feed({ timestamp: Math.floor(NOW / 1000) - 20 });
  await collectOnce(environment(bucket), deps(respond(bytes)));
  const serve = (overrides = {}) => async (input) => {
    const key = new URL(input).pathname.slice(1);
    const object = bucket.objects.get(key);
    if (!object) return new Response('missing', { status: 404 });
    return new Response(object.value, { headers: { 'content-type': object.httpMetadata.contentType, 'cache-control': object.httpMetadata.cacheControl, 'access-control-allow-origin': '*', ...overrides } });
  };
  const good = await checkRealtime('https://cdn.example', { fetcher: serve(), now: () => NOW });
  assert.deepEqual(good.filter((result) => result.severity === 'fail'), []);
  assert.ok(good.some((result) => result.severity === 'warn' && /edge cache/.test(result.name)), 'a direct-from-bucket response without cf-cache-status is flagged');
  const noCors = await checkRealtime('https://cdn.example', { fetcher: serve({ 'access-control-allow-origin': '' }), now: () => NOW });
  assert.ok(noCors.some((result) => result.severity === 'fail' && /CORS/.test(result.name)));
  const stale = await checkRealtime('https://cdn.example', { fetcher: serve(), now: () => NOW + 3600_000 });
  assert.ok(stale.some((result) => result.severity === 'fail' && /fresh/.test(result.name)));
  const empty = await checkRealtime('https://cdn.example', { fetcher: async () => new Response('', { status: 404 }), now: () => NOW });
  assert.equal(empty[0].severity, 'fail');
});

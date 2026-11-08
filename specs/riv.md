# RIV collection, credentials and real-time reconciliation

RIV is a primary real-time source for this provider, including **delays**, not just composition/occupancy enrichment. Some of the data used by iRail is not present in the public GTFS feeds. Access requires the application's RIV key; API access and public redistribution are separate source properties. Keep original protected responses private and publish the permitted normalized fields with their provenance.

## Endpoint and collection strategy

Send the application key in `x-api-key` to `https://mobile-riv.api.belgianrail.be`. All endpoint families share one configured budget, initially 40 requests/minute. Reserve requests in a durable sliding window and coalesce identical work across collectors. Cache successful responses for 60 seconds, preserving their original fetch instant. Bound cached bytes and entry counts to suit Worker storage; the implemented gateway keeps at most ten small responses and returns larger responses uncached.

| Endpoint | Request parameters | Useful data and planned destination |
| --- | --- | --- |
| `/api/v1.0/dacs` | `query=DeparturesApp` or `ArrivalsApp`, seven-digit `UicCode`, Brussels-local `FromDate=YYYY-MM-DD HH:mm:ss` rounded down to 30s, `Count=100` | `PlannedDeparture`/`PlannedArrival`, `DepartureDelay`/`ArrivalDelay` (parsed as duration, not naive numeric minutes), `Platform`, `PlatformChanged`, `Status`, train number/type, origin/destination, halting status. Populate delay estimates **and** stop-status/vehicle-direction observations. Poll arrival and departure boards separately. |
| `/riv/v1.0/journey` | Discovery: `trainFilter`, origin/destination HAFAS IDs, service `date`, local `time`. Planner calls additionally use `lang`, `passlist=1`, `searchForArrival`, `numF=6`, `products` | Discover dated `JourneyDetailRef`, messages, notes and commercial occupancy, including references reusable from other responses. Local route planning still replaces exhaustive origin/destination scraping. |
| `/riv/v1.0/journey/detail` | `id=<JourneyDetailRef>`, `lang` | Full ordered stops with scheduled and realtime arrival/departure dates/times (`rtArrTime`/`rtDepTime` etc.), arrival/departure tracks, independent prognosis/cancellation flags, additional stops, reported states, messages and notes. Produce delay and status observations at each matched call. |
| `/api/v1/commercialtraincompositionsbetweenptcars` | `TrainNumber`, `From`, `To`, service `date`, `FromToAreUicCodes=true`, `IncludeMaterialInfo=true` | Prefer `lastPlanned` to `commercialPlanned` while preserving which was used; ordered units, segment endpoints, confirmation, identities and amenities. Publish compositions with segment and source timestamps. |

Collection jobs should persist discovered journey references by dated run, initially with a four-hour TTL and a 1,000-reference bound. Invalidate and rediscover on parameter errors, and try bounded alternate segments for partially cancelled trains. For a service that began yesterday, try a search over the final two calls with a midnight query time if the upstream search ignores the supplied service date. Discovery requires seven-digit HAFAS station IDs; name-only international stops and unsupported bus details need explicit coverage diagnostics. Validate these cases against recorded source responses. A GTFS-RT cancellation must not suppress a RIV query that could provide fresher running/restoration evidence.

Both non-success HTTP responses **and HTTP-200 `errorCode` / `exception` bodies** are failures, not empty successful datasets. `SVC_PARAM` triggers reference invalidation where appropriate; `SVC_NO_RESULT`, timeouts, location errors, and security rejections have distinct source-status diagnostics. Retry/backoff jobs must consume the same global budget. Never cache an upstream error as an empty board.

## Implemented gateway and configuration

`src/ingest/riv.ts` implements bounded HTTPS requests, fixed endpoint names, `x-api-key`, functional-error detection and board parameters. `src/ingest/riv-gateway.ts` exports `RivGateway`, bound as `RIV_GATEWAY`. All collectors using the same credential must use the **same object name** `sncb-riv` in the same owning Worker namespace. Calling different object names would create separate limits. The gateway coalesces concurrent identical requests, caches small successful responses for 60s, preserves their original `fetchedAt`, and reserves a shared sliding-minute budget before any network request. This is raw transport scaffolding, not the endpoint-specific parser or collector scheduler.

| Variable | Kind | Default / purpose |
| --- | --- | --- |
| `RIV_API_KEY` | Secret | Application key required by enabled requests; sent only in the `x-api-key` header |
| `RIV_ENABLED` | Setting | `false`; gateway rejects work until explicitly enabled |
| `RIV_BASE_URL` | Setting | `https://mobile-riv.api.belgianrail.be`; HTTPS origin only |
| `RIV_LIMIT_RPM` | Setting | `40`, shared across all endpoint families using this gateway |
| `GTFS_RT_TOKEN` | Separate secret | GTFS mirror credential; cannot substitute for RIV's key |

For local development, copy `.dev.vars.example` to the ignored `.dev.vars`, set `RIV_API_KEY=...` and `RIV_ENABLED=true`. For production, set the key without putting it in Wrangler's public `vars`:

```sh
npx wrangler secret put RIV_API_KEY
```

Configure `RIV_ENABLED` and the other non-secret settings in `wrangler.jsonc`. For a future split deployment, set the RIV key **on the Worker owning `RivGateway`** and bind other Workers to that owner's Durable Object; duplicating the key and gateway in every Worker defeats global budgeting. CI uses mocked keys only. Neither HTTP routes nor manifests expose an arbitrary authenticated RIV proxy.

Internal collector usage:

```ts
const gateway = env.RIV_GATEWAY.get(env.RIV_GATEWAY.idFromName('sncb-riv'));
const { value, fetchedAt } = await gateway.request('detail', { id: journeyDetailRef, lang: 'en' });
// Endpoint-specific parser → identity mapping → per-field observations → journal + Arrow snapshots.
```

Enabling RIV currently makes the gateway callable by internal code; it does **not yet schedule a whole-network crawl**. No live credential was used during implementation.

## Collection work to add

1. Add `src/ingest/riv-jobs.ts` and a persistent target/job queue. Expand dated GTFS runs/calls into candidate work and preserve unmapped RIV-only/international trains as unresolved records; do not drop them because static GTFS lacks them. Deduplicate by endpoint, rounded board instant, language, dated train and segment as appropriate.
2. Add `src/ingest/riv-liveboard.ts` and `riv-detail.ts`: prioritize active trains and departure/arrival boards in the near-term horizon. Reserve part of the shared request budget for reference discovery/errors. Poll representative hubs and rotate coverage; publish last-observed age and coverage per station/run. Forty calls/minute cannot poll all stations, both board directions and all trains every minute. Measure actual coverage rather than promising it.
3. Persist discovered journey references with four-hour TTL and explicit invalidation. Reuse references from already-fetched journey responses. Try known alternate segments and the midnight case within a bounded retry budget. Add a station/transport lookup for international and replacement services. Query-discovery identities never become public train identities.
4. Add `riv-compositions.ts` and `riv-occupancy.ts`, with separate refresh priorities and unit/history persistence. Collect localized messages in an explicit rotation; delays do not need four language copies. Publish `observations.arrow` (below), resolved `delays-cancellations.arrow`, `stop-status.arrow`, `occupancy.arrow`, `compositions.arrow`, `alerts.arrow` and associations.
5. Normalize observations to public entity IRIs **before** diffing and writing the shared LDES. Preserve outbox records until the journal acknowledges them; retries reuse the same observation delivery ID. A collector checkpoint is not advanced just because the upstream HTTP response arrived.

## RIV versus GTFS-RT

Keep GTFS-RT protobuf canonical **for the original GTFS-RT feed**, while the application's effective real-time state combines RIV and GTFS-RT. It is incorrect to give GTFS-RT unconditional priority over RIV delays or a RIV whole-journey observation that is actually newer.

`src/realtime/resolve.ts` implements a small reusable per-field policy: discard expired/future observations; when all candidates have comparable actual source update times, select the latest; otherwise prefer a fresh RIV candidate and retain the reason `fresh-riv-policy`. A new fetch time alone is not proof of a newer measurement. Keep the original `fetchedAt` on cache hits. Adapters must supply one latest candidate per channel and determine expiry; start with a 60s RIV and 120s GTFS-RT validity budget, then measure. Record source timestamps when available and do not replace them with guessed values.

Resolve arrival/departure delay, absolute estimate, platform and cancellation independently, at the same matched call and **scope**. Never compare a stop's explicit `false` cancellation directly with a whole-trip cancellation and silently clear the latter. A restored/partially-running trip needs explicit consistent run/segment evidence; retain conflicts and their scopes for diagnostics. Expired/missing RIV data falls back to valid GTFS-RT, then to a visibly unconfirmed schedule. Missing values do not mean zero delay or false cancellation. Full-snapshot disappearance clears that source's prediction, while absence from a paginated/partial RIV board is not a deletion.

`delays-cancellations.arrow` is the resolved materialized view and can be sourced by either channel; it is not a GTFS-RT-only translation. A future `observations.arrow` should retain `iri`, `entityIri`, `sourceIri`, field, typed value, source/fetch/expiry times, scope and resolution status; its typed schema is deferred until source fixture parsers establish the field set. Source observations and resolved entity versions must remain distinguishable in the LDES.

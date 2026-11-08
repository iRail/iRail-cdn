# LC reference tables and iRail enrichment

Exact field order, types and nullability live in [lc-core-schemas.json](lc-core-schemas.json) and [schemas.mjs](schemas.mjs); [arrow-schemas.md](arrow-schemas.md) lists core and side tables. Indices join only within one pinned release. Raw source IDs belong to the separately discovered iRail tables.

## `stops.arrow`

The LC order is `name`, `lat`, `lon`, `parentIdx`, `minTransferTime`, `iri`, `regionIri`. Name and WGS84 coordinates are nullable. `parentIdx` is a non-null Int32 parent row or −1; reject cycles. `minTransferTime` is a non-null Uint32 default vehicle-change buffer in seconds. Preserve actual platform stops and applicable parent-station rules. `regionIri` is nullable when there is no regional partitioning; otherwise every departure stop belongs to its page's region.

`stations.arrow` is the complete curated station list from [iRail/stations](https://github.com/iRail/stations) (pinned commit, CC0, recorded in `irail.json` `sources`): neutral `name`, French/Dutch/German/English alternatives, TAF/TAP and telegraph codes, country, coordinates, average daily stops and the official transfer time. Its `iri` values are the station IRIs minted for `be.sncb`. Every core stop is a station row: feed stops the curated list lacks are added with `source=gtfs` and filled as far as the feed allows (see [arrow-schemas.md](arrow-schemas.md#stationsarrow)). Release diagnostics count curated stations, those matched in the feed, curated ones absent from it, rows added from the feed and stops skipped for missing coordinates. Without the source the capability is `unavailable` and the timetable is unaffected.

`stop-enrichment.arrow` joins through `stopIdx` and the identical `iri`. It preserves raw `stopId`, optional numeric `regionIdx` alias, `stationIri`, `stationId`, `hafasId`, localized `nameNl/nameFr/nameDe/nameEn`, country/TAF-TAP/telegraph codes, `platformCode`, `officialTransferTime`, `avgStopTimes`, `wheelchairBoarding` and nullable `parentIri`. A region number is not an LC partition identifier. Preserve leading zeros in codes, official transfer-time units/provenance and the original station statistic's meaning.

**SNCB.** The core table has exactly one stop per station and its `iri` is the iRail station IRI (`http://irail.be/stations/NMBS/00<hafas>`, also for the foreign stops of the feed); `parentIdx` is −1 everywhere. The feed's `S<uic>` parent rows and `<uic>_<platform>` rows are removed from the disposable GTFS copy before conversion (`scripts/lib/stops.mjs`); no connection or transfer uses them. Platforms are in `platforms.arrow` as `<station IRI>#<platform>`. Platform- or parent-level transfers would collapse to their station, keeping the longest buffer.

Do not invent platforms by trimming raw IDs or apply blanket zero transfer times. The demo uses 120 seconds and has no real-world station mapping. Use the [verified SNCB station identity rules](identifiers.md); international or platform IDs do not automatically use SNCB padding.

## `trips.arrow`

The LC order is `routeIdx`, nullable `headsign`, nullable `shortName`, and `iri`. A trip template may run on many service dates. A dated run is `(tripIdx, serviceDate)` within a release. Train number and block ID alone do not prove identity or in-seat continuity.

`trip-enrichment.arrow` joins by `tripIdx` and `iri`. It preserves raw `tripId`, `routeIri`, nullable `vehicleIri`, `shapeIdx`, `geometryIdx`, nullable `shapeIri`, `directionId`, `blockId`, `wheelchairAccessible` and `bikesAllowed`. Shape/geometry indices use −1 for unavailable; `geometryIdx` remains reserved and the fixture sets −1. There is no separate geometry-pattern or calls table. Per-stop headsign overrides and shape distances, when available, live on the endpoints of `connectionEnrichment`.

## `routes.arrow`

The LC order is nullable `shortName`, nullable `longName`, non-null `routeType`, and non-null `iri`. `route-enrichment.arrow` joins by `routeIdx` and `iri`, retaining raw `routeId` / `agencyId`, `agencyIri` and nullable `product`. Product may distinguish IC/S/L/P/international/replacement buses when supported by the source; preserve unknown classification as unknown.

## `transfers.arrow`

The LC order is nullable `fromStopIdx`, nullable `toStopIdx`, non-null `transferType`, nullable `minTransferTime`, then nullable `fromTripIdx`, `toTripIdx`, `fromRouteIdx`, `toRouteIdx`. A null selector is unconstrained. Types 0–3 require both stop endpoints; type 2 requires a minimum time. Apply GTFS trip/route specificity and station/platform inheritance rather than collapsing all rules into one station buffer.

Types 4 and 5 are **LC core linked-trip rules**, not an unsupported extension. Both trip selectors are required; stop selectors may be null. Type 4 permits in-seat continuation, including split/join links. Type 5 requires alighting and regular boarding/transfer checks. Consumers resolve the applicable dated run endpoints and service-day continuity; a publisher validates both trip indices and any supplied stop indices. Type 1 does not globally eliminate transfer buffers. `transfer-enrichment.arrow` joins through `transferIdx` and preserves a stable rule IRI plus nullable endpoint/selector IRIs, including rules without stop selectors.

## Source enums and consumer stop visits

| Field | Values |
| --- | --- |
| `pickupType`, `dropOffType` | 0 regular; 1 unavailable; 2 contact agency; 3 coordinate with driver. Missing source values default to 0. Codes 2/3 are conditional, not unrestricted service. |
| `wheelchairBoarding`, `wheelchairAccessible` | 0 unknown, 1 possible/accessible, 2 not possible/not accessible; null means absent. Apply parent inheritance where appropriate. |
| `bikesAllowed` | 0 unknown, 1 allowed, 2 not allowed; null absent. |
| `directionId` | Source-specific 0 or 1; no global geographic meaning; null absent. |
| `routeType` | GTFS modes including extended source codes. Unknown codes remain unknown modes. |
| `transferType` | 0 recommended, 1 timed, 2 minimum time, 3 forbidden, 4 in-seat linked trip, 5 linked trip requiring alighting. |

There is no calls dataset. Consumers group connection endpoints by `(tripIdx, serviceDate, stopSequence)` for ordinary visits. Incoming arrival and outgoing departure preserve dwell and terminal events without duplicating the timetable. One-stop service and unindexed additional services need explicitly specified extensions before claiming full coverage; do not fabricate connections or calls. Footpaths, pathways and complete step-free routing require source data and semantics beyond coordinate proximity.

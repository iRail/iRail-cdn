# iRail extension profile, 1-alpha

This profile retains the wider iRail data alongside the unchanged [LC core](lc-core.md). The core manifest uses the LC context plus `irail: https://irail.be/vocab/`, and links to a release-pinned JSON document:

```json
"irail:extensions": { "@id": "/releases/<releaseId>/irail.json" }
```

`irail.json` has `format: irail-cdn-extensions`, `version: 1-alpha`, `releaseId`, `sourceId`, `status`, `identityProfile`, `identityBase`, `generatedAt`, `sources`, `serviceDates`, `partitioning`, `capabilities`, `files`, and an `identityStrategy` descriptor. It is an iRail JSON contract; it is not another LC manifest. Synthetic fixtures use `status: demo`; the production SNCB build uses `status: available`. Capabilities are `available`, `unavailable` (no source or not yet implemented) or `unconfigured` (live source not set up), and a production `irail.json` additionally carries `diagnostics` (unsupported GTFS counts and explanatory notes) and, per source, the archive hash, feed window and converter commit. Unavailable sources are not advertised as collected empty data.

`files` is the integrity catalog for every core and extension IPC file. Entries have `path`, `rowCount`, `byteLength`, lowercase SHA-256 `sha256` and `mediaType`. The `connections` entry is an array; the other fixture entries are individual descriptors. Shapes' point files are cataloged under `shapePoints` in the single-shape fixture; production catalogs must enumerate every point file. Hashes describe final file bytes after HTTP content decoding. `identityStrategy` uses `path`, `byteLength`, `sha256`, `mediaType` and pins the effective shared minting rules. The catalog does not hash itself.

The extension manifest, catalog and all static extension files are pinned to the LC `releaseId`. Numeric indices reference that release's dictionaries. Dictionary-related extension tables have one row per enriched core row, with an explicit index and the same `iri`; rows need not occupy the core row's position. `connectionEnrichment` joins by the core connection's `iri`. `transferEnrichment` uses `transferIdx`, since core transfers have no IRI column.

| Dataset | Data beyond LC |
| --- | --- |
| `stations` | Curated station list in all languages (iRail/stations): names, alternatives, TAF/TAP and telegraph codes, country, coordinates, average stops, official transfer time |
| `stopEnrichment` | Raw `stopId`, optional local region alias, station identity/codes, multilingual names, platform, transfer provenance and accessibility |
| `tripEnrichment` | Raw `tripId`, route IRI, vehicle/display identity, shape/geometry references, direction/block and accessibility |
| `routeEnrichment` | Raw `routeId` / `agencyId`, agency IRI and product |
| `connectionEnrichment` | Stable trip/run/stop/event relationship IRIs, nullable endpoint headsigns and shape distances |
| `transferEnrichment` | Transfer identity and nullable stop/trip/route IRIs, including linked rules without stop selectors |
| `shapes`, `shapePoints` | Ordered display geometry |
| `compositions`, `occupancy`, `alerts`, `alertEntities`, `stopStatus`, `delaysCancellations` | Independently specified enrichment and live overlays |

The full ordered fields are in [arrow-schemas.md](arrow-schemas.md). Extension Arrow metadata uses `format=irail-cdn-extensions`, `schemaVersion=1-alpha`, `identityProfile=irail-global-v1`, `dataset=<extension key>`, and the pinned static `releaseId`. This version is independent of LC `2-alpha` and the identity-strategy grammar. Required fields in separate side tables do not become additional required LC columns.

Event IRIs do not require a calls table. An arriving endpoint and a later departure with the same `(tripIdx, serviceDate, stopSequence)` identify one ordinary stop visit. Consumers reconstruct the visit and join overlays by that key or the event relationship IRIs in `connectionEnrichment`. Endpoint shape distances preserve GTFS anchors without repeating scheduled stop times in a second table.

Live snapshots retain independent generation, freshness, provenance and `staticReleaseId`; they do not alter static LC bytes. Unindexed additional services, frequency-instance reconciliation, history, forecasts and detailed track data remain required follow-up contracts where not yet defined. The raw protobuf, RIV transport and Jelly-RDF journal keep their separate live contracts. All planned builds/publication precede new Cloudflare integration work.

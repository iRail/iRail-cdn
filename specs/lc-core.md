# Linked Connections 2.0-alpha core

The authoritative draft is [Linked Connections 2.0-alpha](https://linkedconnections.org/specification/2-0-alpha). This repository pins the reviewed revision and local schema/context hashes in [lc-contract.json](../config/lc-contract.json). The core schemas are copied verbatim into [lc-core-schemas.json](lc-core-schemas.json) and used by [schemas.mjs](schemas.mjs). Core fields are not derived from the larger iRail profile.

| Dataset | Ordered baseline |
| --- | --- |
| `connections` | `departureStopIdx`, `arrivalStopIdx`, `departureTimeOffset`, `arrivalTimeOffset`, `tripIdx`, `pickupType`, `dropOffType`, `serviceDate`, `stopSequence`, `arrivalStopSequence`, `iri` |
| `stops` | `name`, `lat`, `lon`, `parentIdx`, `minTransferTime`, `iri`, `regionIri` |
| `trips` | `routeIdx`, `headsign`, `shortName`, `iri` |
| `routes` | `shortName`, `longName`, `routeType`, `iri` |
| `transfers` | `fromStopIdx`, `toStopIdx`, `transferType`, `minTransferTime`, `fromTripIdx`, `toTripIdx`, `fromRouteIdx`, `toRouteIdx` |

[The ordered schema reference](arrow-schemas.md) gives every type and nullability. In particular, transfer stop indices are nullable, and `regionIri` is a nullable Utf8 IRI rather than a local region number. Types 0–3 require stop endpoints; types 4/5 require both trip selectors and permit missing stop endpoints. A type-2 rule requires a minimum time.

Core IPC metadata contains `schemaVersion=2-alpha`, `dataset` and `releaseId`. Connections additionally require `epochSeconds` and a region IRI when region-partitioned. All referenced dictionaries/pages belong to the pinned release. Use primitive Utf8 identity columns and Arrow validity bitmaps for nulls.

The JSON-LD entry point is a `Timetable` with IRI strings for `stops`, `trips`, `routes` and, when present, `transfers`. Connections use a `ConnectionCollection`; this provider lists pages explicitly. File-integrity descriptors, raw identifiers and capabilities are iRail extension data, not bare LC properties. There is no core calls dataset.

Resources support GET/HEAD and `Access-Control-Allow-Origin: *`. Media types are `application/ld+json`, `application/vnd.apache.arrow.file` and `application/x-protobuf` for native GTFS-RT feeds. Validate native Pages HTTP behavior before production conformance is claimed. A feed can appear in optional `realtime[]` only when its RFC 6570 templates reproduce the core dictionary IRIs exactly. Lookup-based reconciliation remains an iRail capability outside that native link contract.

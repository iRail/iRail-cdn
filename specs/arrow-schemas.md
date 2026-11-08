# Complete Arrow schemas: LC2-alpha and iRail extensions

The five core tables use the exact LC2-alpha baseline pinned in [lc-core-schemas.json](lc-core-schemas.json) and [lc-contract.json](../config/lc-contract.json). [schemas.mjs](schemas.mjs) is executable; the remaining tables use the separately versioned [iRail extension profile](irail-profile.md). There is no calls schema.

Positions specify IPC field order. Integer indices are zero-based within the pinned release; nullability, widths and primitive Utf8 IRIs are part of the contract. Empty tables retain the full typed schema. File encoding and time units are defined in [the overview](README.md#wire-conventions).

## `connections.arrow`

Schema metadata `dataset=connections`, `schemaVersion=2-alpha`, and `releaseId=<static release>`. LC core. Pages additionally require `epochSeconds` and `region` when region-partitioned.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `departureStopIdx` | Int32 | no |
| 2 | `arrivalStopIdx` | Int32 | no |
| 3 | `departureTimeOffset` | Uint32 | no |
| 4 | `arrivalTimeOffset` | Uint32 | no |
| 5 | `tripIdx` | Int32 | no |
| 6 | `pickupType` | Uint8 | no |
| 7 | `dropOffType` | Uint8 | no |
| 8 | `serviceDate` | Uint32 | no |
| 9 | `stopSequence` | Uint32 | no |
| 10 | `arrivalStopSequence` | Uint32 | no |
| 11 | `iri` | Utf8 | no |

## `stops.arrow`

Schema metadata `dataset=stops`, `schemaVersion=2-alpha`, and `releaseId=<static release>`. LC core.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `name` | Utf8 | yes |
| 2 | `lat` | Float64 | yes |
| 3 | `lon` | Float64 | yes |
| 4 | `parentIdx` | Int32 | no |
| 5 | `minTransferTime` | Uint32 | no |
| 6 | `iri` | Utf8 | no |
| 7 | `regionIri` | Utf8 | yes |

## `trips.arrow`

Schema metadata `dataset=trips`, `schemaVersion=2-alpha`, and `releaseId=<static release>`. LC core.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `routeIdx` | Int32 | no |
| 2 | `headsign` | Utf8 | yes |
| 3 | `shortName` | Utf8 | yes |
| 4 | `iri` | Utf8 | no |

## `routes.arrow`

Schema metadata `dataset=routes`, `schemaVersion=2-alpha`, and `releaseId=<static release>`. LC core.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `shortName` | Utf8 | yes |
| 2 | `longName` | Utf8 | yes |
| 3 | `routeType` | Int32 | no |
| 4 | `iri` | Utf8 | no |

## `transfers.arrow`

Schema metadata `dataset=transfers`, `schemaVersion=2-alpha`, and `releaseId=<static release>`. LC core.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `fromStopIdx` | Int32 | yes |
| 2 | `toStopIdx` | Int32 | yes |
| 3 | `transferType` | Uint8 | no |
| 4 | `minTransferTime` | Uint32 | yes |
| 5 | `fromTripIdx` | Int32 | yes |
| 6 | `toTripIdx` | Int32 | yes |
| 7 | `fromRouteIdx` | Int32 | yes |
| 8 | `toRouteIdx` | Int32 | yes |

## `stop-enrichment.arrow`

Schema metadata `dataset=stopEnrichment`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `stopIdx` | Int32 | no |
| 2 | `stopId` | Utf8 | no |
| 3 | `regionIdx` | Int32 | yes |
| 4 | `stationIri` | Utf8 | yes |
| 5 | `stationId` | Utf8 | yes |
| 6 | `hafasId` | Utf8 | yes |
| 7 | `nameNl` | Utf8 | yes |
| 8 | `nameFr` | Utf8 | yes |
| 9 | `nameDe` | Utf8 | yes |
| 10 | `nameEn` | Utf8 | yes |
| 11 | `countryCode` | Utf8 | yes |
| 12 | `tafTapCode` | Utf8 | yes |
| 13 | `telegraphCode` | Utf8 | yes |
| 14 | `platformCode` | Utf8 | yes |
| 15 | `officialTransferTime` | Uint32 | yes |
| 16 | `avgStopTimes` | Float64 | yes |
| 17 | `wheelchairBoarding` | Uint8 | yes |
| 18 | `iri` | Utf8 | no |
| 19 | `parentIri` | Utf8 | yes |

## `trip-enrichment.arrow`

Schema metadata `dataset=tripEnrichment`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `tripIdx` | Int32 | no |
| 2 | `tripId` | Utf8 | no |
| 3 | `vehicleIri` | Utf8 | yes |
| 4 | `shapeIdx` | Int32 | no |
| 5 | `geometryIdx` | Int32 | no |
| 6 | `directionId` | Uint8 | yes |
| 7 | `blockId` | Utf8 | yes |
| 8 | `wheelchairAccessible` | Uint8 | yes |
| 9 | `bikesAllowed` | Uint8 | yes |
| 10 | `iri` | Utf8 | no |
| 11 | `routeIri` | Utf8 | no |
| 12 | `shapeIri` | Utf8 | yes |

## `route-enrichment.arrow`

Schema metadata `dataset=routeEnrichment`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `routeIdx` | Int32 | no |
| 2 | `routeId` | Utf8 | no |
| 3 | `agencyId` | Utf8 | no |
| 4 | `product` | Utf8 | yes |
| 5 | `iri` | Utf8 | no |
| 6 | `agencyIri` | Utf8 | no |

## `connection-enrichment.arrow`

Schema metadata `dataset=connectionEnrichment`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `departureHeadsign` | Utf8 | yes |
| 2 | `arrivalHeadsign` | Utf8 | yes |
| 3 | `departureShapeDistance` | Float64 | yes |
| 4 | `arrivalShapeDistance` | Float64 | yes |
| 5 | `iri` | Utf8 | no |
| 6 | `tripIri` | Utf8 | no |
| 7 | `runIri` | Utf8 | no |
| 8 | `departureStopIri` | Utf8 | no |
| 9 | `arrivalStopIri` | Utf8 | no |
| 10 | `departureCallIri` | Utf8 | no |
| 11 | `arrivalCallIri` | Utf8 | no |

## `transfer-enrichment.arrow`

Schema metadata `dataset=transferEnrichment`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `transferIdx` | Int32 | no |
| 2 | `iri` | Utf8 | no |
| 3 | `fromStopIri` | Utf8 | yes |
| 4 | `toStopIri` | Utf8 | yes |
| 5 | `fromTripIri` | Utf8 | yes |
| 6 | `toTripIri` | Utf8 | yes |
| 7 | `fromRouteIri` | Utf8 | yes |
| 8 | `toRouteIri` | Utf8 | yes |

## `shapes.arrow`

Schema metadata `dataset=shapes`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `shapeId` | Utf8 | no |
| 2 | `path` | Utf8 | no |
| 3 | `pointCount` | Uint32 | no |
| 4 | `distanceUnit` | Utf8 | yes |
| 5 | `iri` | Utf8 | no |

## `shapes/<id>.arrow`

Schema metadata `dataset=shapePoints`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `sequence` | Uint32 | no |
| 2 | `lat` | Float64 | no |
| 3 | `lon` | Float64 | no |
| 4 | `distance` | Float64 | yes |
| 5 | `iri` | Utf8 | no |
| 6 | `shapeIri` | Utf8 | no |

## `compositions.arrow`

Schema metadata `dataset=compositions`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `tripIdx` | Int32 | no |
| 2 | `serviceDate` | Uint32 | no |
| 3 | `segmentId` | Utf8 | no |
| 4 | `fromStopSequence` | Uint32 | no |
| 5 | `toStopSequence` | Uint32 | no |
| 6 | `position` | Uint32 | no |
| 7 | `unitUic` | Utf8 | yes |
| 8 | `materialNumber` | Utf8 | yes |
| 9 | `materialType` | Utf8 | yes |
| 10 | `materialSubType` | Utf8 | yes |
| 11 | `materialSubTypeName` | Utf8 | yes |
| 12 | `tractionType` | Utf8 | yes |
| 13 | `orientation` | Utf8 | yes |
| 14 | `confirmedBy` | Utf8 | yes |
| 15 | `seatsFirstClass` | Uint32 | yes |
| 16 | `seatsSecondClass` | Uint32 | yes |
| 17 | `seatsCoupeFirstClass` | Uint32 | yes |
| 18 | `seatsCoupeSecondClass` | Uint32 | yes |
| 19 | `standingPlacesFirstClass` | Uint32 | yes |
| 20 | `standingPlacesSecondClass` | Uint32 | yes |
| 21 | `tractionPosition` | Uint32 | yes |
| 22 | `lengthInMeter` | Float32 | yes |
| 23 | `hasToilet` | Bool | yes |
| 24 | `hasPrmToilet` | Bool | yes |
| 25 | `hasTables` | Bool | yes |
| 26 | `hasFirstClassOutlets` | Bool | yes |
| 27 | `hasSecondClassOutlets` | Bool | yes |
| 28 | `hasHeating` | Bool | yes |
| 29 | `hasAirco` | Bool | yes |
| 30 | `hasBikeSection` | Bool | yes |
| 31 | `canPassToNextUnit` | Bool | yes |
| 32 | `hasSemiAutomaticInteriorDoors` | Bool | yes |
| 33 | `hasLuggageSection` | Bool | yes |
| 34 | `hasPrmSection` | Bool | yes |
| 35 | `hasPriorityPlaces` | Bool | yes |
| 36 | `source` | Utf8 | no |
| 37 | `observedAt` | Int64 | no |
| 38 | `iri` | Utf8 | no |
| 39 | `tripIri` | Utf8 | no |
| 40 | `runIri` | Utf8 | no |
| 41 | `fromCallIri` | Utf8 | no |
| 42 | `toCallIri` | Utf8 | no |
| 43 | `sourceIri` | Utf8 | no |
| 44 | `unitIri` | Utf8 | yes |

## `occupancy.arrow`

Schema metadata `dataset=occupancy`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `tripIdx` | Int32 | no |
| 2 | `serviceDate` | Uint32 | no |
| 3 | `stopSequence` | Uint32 | no |
| 4 | `level` | Utf8 | no |
| 5 | `score` | Float32 | yes |
| 6 | `source` | Utf8 | no |
| 7 | `observedAt` | Int64 | no |
| 8 | `expiresAt` | Int64 | yes |
| 9 | `iri` | Utf8 | no |
| 10 | `callIri` | Utf8 | no |
| 11 | `sourceIri` | Utf8 | no |

## `alerts.arrow`

Schema metadata `dataset=alerts`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `alertId` | Utf8 | no |
| 2 | `language` | Utf8 | no |
| 3 | `type` | Utf8 | no |
| 4 | `header` | Utf8 | yes |
| 5 | `lead` | Utf8 | yes |
| 6 | `description` | Utf8 | yes |
| 7 | `company` | Utf8 | yes |
| 8 | `linksJson` | Utf8 | yes |
| 9 | `validFrom` | Int64 | yes |
| 10 | `validTo` | Int64 | yes |
| 11 | `modifiedAt` | Int64 | yes |
| 12 | `source` | Utf8 | no |
| 13 | `observedAt` | Int64 | no |
| 14 | `iri` | Utf8 | no |
| 15 | `sourceIri` | Utf8 | no |

## `alert-entities.arrow`

Schema metadata `dataset=alertEntities`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `alertId` | Utf8 | no |
| 2 | `stopIdx` | Int32 | yes |
| 3 | `routeIdx` | Int32 | yes |
| 4 | `tripIdx` | Int32 | yes |
| 5 | `serviceDate` | Uint32 | yes |
| 6 | `stopSequence` | Uint32 | yes |
| 7 | `iri` | Utf8 | no |
| 8 | `alertIri` | Utf8 | no |
| 9 | `stopIri` | Utf8 | yes |
| 10 | `routeIri` | Utf8 | yes |
| 11 | `tripIri` | Utf8 | yes |
| 12 | `runIri` | Utf8 | yes |
| 13 | `callIri` | Utf8 | yes |

## `stop-status.arrow`

Schema metadata `dataset=stopStatus`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `tripIdx` | Int32 | no |
| 2 | `serviceDate` | Uint32 | no |
| 3 | `stopSequence` | Uint32 | no |
| 4 | `arrivalPlatform` | Utf8 | yes |
| 5 | `departurePlatform` | Utf8 | yes |
| 6 | `arrivalCancelled` | Bool | yes |
| 7 | `departureCancelled` | Bool | yes |
| 8 | `isExtra` | Bool | yes |
| 9 | `arrivalState` | Utf8 | yes |
| 10 | `departureState` | Utf8 | yes |
| 11 | `notesJson` | Utf8 | yes |
| 12 | `source` | Utf8 | no |
| 13 | `observedAt` | Int64 | no |
| 14 | `iri` | Utf8 | no |
| 15 | `callIri` | Utf8 | no |
| 16 | `sourceIri` | Utf8 | no |

## `delays-cancellations.arrow`

Schema metadata `dataset=delaysCancellations`, `schemaVersion=1-alpha`, and `releaseId=<static release>`. iRail side table, with `format=irail-cdn-extensions` and `identityProfile=irail-global-v1`.

| Position | Field | Arrow type | Nullable |
| --- | --- | --- | --- |
| 1 | `tripIdx` | Int32 | no |
| 2 | `serviceDate` | Uint32 | no |
| 3 | `stopSequence` | Uint32 | no |
| 4 | `scope` | Utf8 | no |
| 5 | `scheduleRelationship` | Utf8 | no |
| 6 | `arrivalTime` | Int64 | yes |
| 7 | `departureTime` | Int64 | yes |
| 8 | `arrivalDelay` | Int32 | yes |
| 9 | `departureDelay` | Int32 | yes |
| 10 | `assignedStopIdx` | Int32 | yes |
| 11 | `uncertainty` | Uint32 | yes |
| 12 | `source` | Utf8 | no |
| 13 | `observedAt` | Int64 | no |
| 14 | `iri` | Utf8 | no |
| 15 | `tripIri` | Utf8 | no |
| 16 | `runIri` | Utf8 | no |
| 17 | `sourceIri` | Utf8 | no |
| 18 | `callIri` | Utf8 | yes |
| 19 | `assignedStopIri` | Utf8 | yes |

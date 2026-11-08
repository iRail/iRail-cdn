# `compositions.arrow`

Arrow fits a browsable, joinable rolling-stock snapshot. Publish one row per ordered unit within a composition segment of a dated train. Multiple segments represent coupling/uncoupling or changed rolling stock along the journey. Identity is `(tripIdx, serviceDate, segmentId, position)` in the current snapshot. For history, preserve distinct observation versions instead of overwriting the only copy.

| Fields | Arrow type | Nullable | Meaning |
| --- | --- | --- | --- |
| `tripIdx` | Int32 | no | Trip dictionary row |
| `serviceDate` | Uint32 | no | Original train service day |
| `segmentId` | Utf8 | no | Release/run-local segment identity from upstream or deterministic endpoints |
| `fromStopSequence`, `toStopSequence` | Uint32 | no | Segment call bounds: applies to connection departure sequences in `[from,to)` |
| `position` | Uint32 | no | Zero-based unit order as returned for this segment, not necessarily physical front-to-back without direction context |
| `unitUic`, `materialNumber` | Utf8 | yes | Physical unit identity and material number; strings preserve digits/leading zeros |
| `materialType`, `materialSubType`, `materialSubTypeName`, `tractionType` | Utf8 | yes | Normalized type/subtype plus original descriptive subtype and traction classification |
| `orientation` | Utf8 | yes | `left` / `right` as rolling-material display orientation, or null if unknown; not geographical heading |
| `confirmedBy` | Utf8 | yes | Upstream confirmation/origin indicator |
| `seatsFirstClass`, `seatsSecondClass` | Uint32 | yes | Class seat totals; 0 is known zero |
| `seatsCoupeFirstClass`, `seatsCoupeSecondClass` | Uint32 | yes | Compartment-seat values retained with upstream meaning; do not blindly add to class totals |
| `standingPlacesFirstClass`, `standingPlacesSecondClass` | Uint32 | yes | Standing capacity per class |
| `tractionPosition` | Uint32 | yes | Original traction-position code |
| `lengthInMeter` | Float32 | yes | Unit length in metres |
| `hasToilet`, `hasPrmToilet`, `hasTables` | Bool | yes | Reported facilities |
| `hasFirstClassOutlets`, `hasSecondClassOutlets`, `hasHeating`, `hasAirco` | Bool | yes | Reported facilities |
| `hasBikeSection`, `canPassToNextUnit`, `hasSemiAutomaticInteriorDoors` | Bool | yes | Bicycle section, gangway and doors |
| `hasLuggageSection`, `hasPrmSection`, `hasPriorityPlaces` | Bool | yes | Luggage and accessibility facilities |
| `source` | Utf8 | no | E.g. `sncb-riv:lastPlanned`, `sncb-riv:commercialPlanned`, or explicitly named history fallback |
| `observedAt` | Int64 | no | UTC observation seconds |

Resolve segment endpoints against the ordered call list, including repeated stations. Reject ambiguous endpoints or publish an unresolved-source diagnostic; do not attach a full-day composition to an arbitrary loop segment. A public train number may span multiple GTFS templates; use dated run/segment matching. All units in one segment share observation/source and contiguous positions. A locomotive is a unit and may have known zero passenger capacity. Single-unit compositions are valid.

Unknown amenities remain null; an absent source field is not evidence that an amenity is false. Preserve raw type information and version material/orientation heuristics. Only sum capacities when unit coverage is complete and the upstream capacity categories are understood. Old composition history can support fallback, but must be identified as historical rather than an observed current formation.

The fixture exports a correctly typed empty table with capability `unavailable`. It demonstrates schema loading, not successful SNCB collection. Production work needs RIV access, bounded collection, a persisted unit/history store, and reconciliation against dated trips as described in [PLAN.md](../PLAN.md).

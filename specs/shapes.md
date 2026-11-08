# Route geometry and railway tracks

`shapes.arrow` is a small lookup table, one row per GTFS route polyline. The iRail `tripEnrichment` side table references it with `shapeIdx`; −1 means unavailable. Points are fetched only for the ride legs a client renders.

| Index field | Arrow type | Nullable | Meaning |
| --- | --- | --- | --- |
| `shapeId` | Utf8 | no | Source GTFS shape ID |
| `path` | Utf8 | no | Immutable origin-relative URL of point file |
| `pointCount` | Uint32 | no | Number of point rows |
| `distanceUnit` | Utf8 | yes | Declared units for distance (e.g. `m`), or null when native GTFS units are unknown |

Each `shapes/<id>.arrow` point file uses the `shapePoints` schema:

| Field | Arrow type | Nullable | Meaning |
| --- | --- | --- | --- |
| `sequence` | Uint32 | no | Original ordered `shape_pt_sequence` |
| `lat`, `lon` | Float64 | no | WGS84 latitude/longitude degrees |
| `distance` | Float64 | yes | Original `shape_dist_traveled`; not necessarily metres |

Sequences are strictly increasing but need not be contiguous. Coordinates must be finite/in range. Distances, where available, are nondecreasing and must use the same units as `connectionEnrichment.departureShapeDistance` / `arrivalShapeDistance`. Missing source shapes are an explicit capability gap; do not create precise-looking geometry from station pairs.

To display a ride, find the trip's shape index, fetch its point file and clip against the ride's first/last **call sequences**. Use all ordered call anchors and shape distances to avoid snapping a loop's final station to its first occurrence. When distances are absent, use a monotone projection through the ordered call list. Fallback to a clearly approximate straight line when geometry is absent. Shape geometry affects display, never the timetable or connectivity rules.

The iRail extension profile defines this index/point-file representation, with explicit distance units and IRI relationships. Endpoint distances and headsigns belong to `connectionEnrichment`; ordinary stop ordering/times come from LC connections. Consumers reconstruct ordered stop visits, without a calls dataset. The reserved `tripEnrichment.geometryIdx` is −1; no separate geometry-pattern dataset is required.

## Physical railway tracks (future)

GTFS shapes are route paths, not a graph of all physical tracks, switches, signals or platform connections. For detailed track rendering, add a separately sourced `tracks.arrow` after choosing an Infrabel/open geographic source and verifying its coordinate system and coverage. A proposed future schema is `trackId: Utf8`, nullable `fromNodeId/toNodeId: Utf8`, `geometryWkb: Binary`, nullable `lineCode: Utf8`, and source/version metadata with an explicit CRS. This is **not** part of the executable extension contracts and no track source has been selected or scraped.

Do not use GTFS shape proximity to derive safe walking paths, train routing over the physical network, track assignment, or exact vehicle location. Those require additional data and semantics.

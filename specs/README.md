# iRail CDN: LC2.0-alpha and iRail extensions

The routing core follows **[Linked Connections 2.0-alpha](https://linkedconnections.org/specification/2-0-alpha)**. The five core Arrow tables use its exact ordered fields, types and nullability. Additional iRail data uses a separately versioned **iRail extension profile, `1-alpha`**. This is an experimental contract; there is no previous deployed format to preserve.

[lc-core-schemas.json](lc-core-schemas.json) and [lc-context.jsonld](lc-context.jsonld) snapshot the reviewed LC artifacts. [config/lc-contract.json](../config/lc-contract.json) records their revision and hashes. [schemas.mjs](schemas.mjs) builds executable Arrow schemas from that baseline and the iRail extension definitions; [the ordered reference](arrow-schemas.md) lists all columns.

The generated fixtures and example reader implement these contracts. Production SNCB conversion and live normalization remain incomplete. [PLAN.md](../PLAN.md#delivery-order) builds the GitHub Actions/Pages planned pipeline first, followed by the Cloudflare live service. A defined field does not imply an available source.

| Resource | Purpose | Contract |
| --- | --- | --- |
| `manifest.jsonld` | LC `Timetable`, release, coverage and IRI-based discovery | [LC core](lc-core.md), [publication](publication.md) |
| `connections` pages | Adjacent scheduled stop-to-stop connections | [Connections](planning.md) |
| `stops.arrow`, `trips.arrow`, `routes.arrow`, `transfers.arrow` | LC reference dictionaries and transfer rules | [Reference tables](reference.md) |
| `irail.json` | Release-pinned integrity catalog, provenance, capabilities and extension discovery | [iRail profile](irail-profile.md) |
| `stop-enrichment.arrow`, `trip-enrichment.arrow`, `route-enrichment.arrow` | Raw aliases, curated reference fields, agency and shape relationships | [Reference tables](reference.md) |
| `connection-enrichment.arrow`, `transfer-enrichment.arrow` | Stable relationship IRIs and optional endpoint/shape enrichment | [iRail profile](irail-profile.md) |
| `shapes.arrow`, `shapes/*.arrow` | Shape index and ordered polylines | [Shapes](shapes.md) |
| `trip-updates.pb`, optional `delays-cancellations.arrow` | Original GTFS-RT and resolved updates | [Real-time](realtime.md) |
| `compositions.arrow`, `occupancy.arrow` | Ordered units, observations and forecasts | [Compositions](compositions.md), [occupancy](enrichment.md#occupancyarrow) |
| `alerts.arrow`, `alert-entities.arrow`, `stop-status.arrow` | Disturbances, associations and status | [Enrichment](enrichment.md) |
| `/feed` | Twelve-hour Jelly-RDF LDES of observations | [Feed](ldes.md) |

There is **no calls dataset or provider-side stop-visit service**. Consumers reconstruct ordinary visits, dwell and terminal arrivals from connection endpoints. Stop-event IRIs in independent overlays identify events without creating another timetable table.

## Wire conventions

- `.arrow` resources are independently readable **Arrow IPC files**, little-endian and without IPC compression, with `ARROW1` framing and MIME `application/vnd.apache.arrow.file`. HTTP content encoding is independent of IPC encoding. Read with Arrow JS `tableFromIPC` or Python `pyarrow.ipc.open_file`.
- Core metadata is `schemaVersion=2-alpha`, `dataset=<core key>`, `releaseId=<release>`. Connection pages also have decimal `epochSeconds` and `region` when partitioned. iRail side tables use `format=irail-cdn-extensions`, `schemaVersion=1-alpha`, `identityProfile=irail-global-v1`, their own `dataset` and the same static `releaseId`.
- Core schemas remain exactly LC. Compatible appended columns must be nullable; this provider uses separate iRail tables for richer required fields. Plain LC consumers need no iRail tables. Consumers check version/types/nullability and ignore unknown columns.
- Connection times are `Uint32` seconds relative to the page epoch. Extension `Int64` times are POSIX UTC seconds, represented as `bigint` by Arrow JS. JSON dates/bounds use ISO 8601 UTC; `epochSeconds` and raw feed timestamps are numeric POSIX seconds.
- `serviceDate: Uint32` is the original GTFS service day `YYYYMMDD` in the agency timezone. Overnight and DST expansion follow GTFS semantics; never derive the service date from UTC departure. Original stop sequences can have gaps and repeated stops.
- Dictionary indices are zero-based row positions within one release. `parentIdx=-1` means no parent; nullable selectors use null. Never join indices across releases. IDs and station codes remain strings in the iRail alias tables.
- Null means unknown/unavailable, distinct from zero, false or an empty successful dataset. Empty tables keep their full typed schema. Check iRail capabilities and live freshness before interpreting source availability.
- Coordinates are WGS84 degrees. Shape geometry does not imply railway topology, safe walking or exact vehicle location.

## Consumer entry point

```js
import { tableFromIPC } from 'apache-arrow';

const response = await fetch('http://localhost:8787/manifest.jsonld');
if (!response.ok) throw new Error(`Manifest: ${response.status}`);
const manifest = await response.json();
if (manifest.schemaVersion !== '2-alpha') throw new Error('Unsupported LC version');
const page = manifest.connections.pages[0];
const bytes = await fetch(new URL(page['@id'], response.url)).then(r => r.arrayBuffer());
const table = tableFromIPC(bytes);
if (table.schema.metadata.get('releaseId') !== manifest.releaseId) throw new Error('Release mismatch');
const departureSeconds = Number(table.schema.metadata.get('epochSeconds')) + table.getChild('departureTimeOffset').get(0);
```

Production clients also validate schema metadata, coverage, page selection and HTTP status; iRail consumers verify the extension catalog's hashes. Pin one release for the whole query and restart if another release is encountered. See [the runnable core-only example](../examples/plan.mjs), [global identifiers](identifiers.md) and [RIV collection](riv.md).

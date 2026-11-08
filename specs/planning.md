# Planning connections and route planning

`connections` is a logical dataset. A release may publish one file or multiple manifest-indexed pages. Each row is one scheduled adjacent call-to-call ride. Its public identity is `iri`; `(tripIdx, serviceDate, stopSequence)` is its release-local key. `arrivalStopSequence` retains the next original call sequence, which need not be consecutive.

Generate the schedule from one pinned GTFS archive and deterministic identifier/partition configuration. Planning has no dependency on RIV, user reports or forecasting services. Crowdedness observations and forecasts are published separately in [`occupancy.arrow`](enrichment.md#occupancyarrow), joined by the departure call IRI in `connectionEnrichment`, or by the dated run/sequence key. Updating them never requires regenerating planning pages.

This document describes the LC2-alpha connection representation and iRail publication policy. The table below describes the numeric/value fields; [global identifiers](identifiers.md#arrow-references) defines the IRI fields. [The ordered schema reference](arrow-schemas.md#connectionsarrow) includes every field, its exact position, type and nullability.

| Field | Arrow type | Nullable | Meaning |
| --- | --- | --- | --- |
| `departureStopIdx`, `arrivalStopIdx` | Int32 | no | Boarding/alighting rows in stops; preserve actual platforms |
| `departureTimeOffset`, `arrivalTimeOffset` | Uint32 | no | Scheduled POSIX seconds minus the page's `epochSeconds` |
| `tripIdx` | Int32 | no | Row in trips |
| `pickupType`, `dropOffType` | Uint8 | no | GTFS code at departure and arrival respectively; default 0 |
| `serviceDate` | Uint32 | no | Original service date YYYYMMDD |
| `stopSequence` | Uint32 | no | Departure call sequence |
| `arrivalStopSequence` | Uint32 | no | Arrival call sequence, strictly greater than departure sequence |
| `iri` | Utf8 | no | Canonical connection IRI |

This provider chooses six-hour UTC bucket starts for epochs; LC permits other cuts. In this publication policy, departure offset is less than 21,600. Arrival offsets may extend beyond that bucket, including another day. Reject values outside Uint32; never wrap. Scheduled times and connection keys stay fixed when real-time updates arrive.

## Partitioning and order

Assign each departure stop exactly one `regionIri` identified by its IRI. Region assignment is producer-defined and remains fixed within a release; consumers need no particular clustering algorithm. A connection belongs to the region of its **departure** stop and is not duplicated in its arrival region. The page's `arrivalRegions` lists all destination-region IRIs present in that page.

Bucket each scheduled departure by `epochSeconds = floor(departureSeconds / 21600) * 21600`. Buckets are the half-open UTC intervals beginning at 00:00, 06:00, 12:00 and 18:00. Group by departure region and bucket, sort by `(departureTimeOffset, tripIdx, serviceDate, stopSequence)`, then split into independently readable pages of at most 50,000 rows. All record batches within a page preserve this order. Sparse region/bucket combinations need no empty pages. This is the explicit page-list strategy, not ScheduledPagination, because a bucket may be split into several files.

Within a region/bucket, consecutive pages preserve the same sort order, but equal departures may cross page boundaries. Across regions, consumers merge page cursors using absolute departure time; the manifest array alone is not a global scan order. Each LC page entry carries its IRI, epoch, region and inclusive actual minimum/maximum departure times. Row counts and hashes live in the iRail integrity catalog. Arrival offsets are never reduced modulo a bucket or day.

For example, a page with epoch `2026-11-07T06:00:00Z` and a row with departure/arrival offsets 7,200/7,800 represents an 08:00–08:10 UTC ride. Its service date can differ from the UTC departure date for after-midnight services. Scheduled identity and sort bounds do not change when an independent real-time overlay estimates a different departure.

## Constructing a planner

1. Fetch and pin a manifest. Check the query is inside the actual coverage. Load stops and transfer rules; trips/routes can load lazily for labels/transport filters.
2. Resolve station names/IDs to a station family. Match both parent and child platform stops, preserving actual event locations in results. Initialize access labels for all reachable entry stops, including walking where supported.
3. Select candidate pages by departure bounds and regions. Decode their Arrow columns and heap-merge them in global departure order; equal times can span multiple pages. Handle equal-time zero-duration chains to a fixed point before advancing time. `epoch + offset` gives absolute UTC seconds; JavaScript uses Number safely for the supported horizon.
4. For a forward earliest-arrival Connection Scan, board only when a reachable stop label plus applicable transfer/walking constraints catches departure, and pickup permits boarding. Separately track on-board state for each **dated run**, with event sequence continuity. Staying on that train bypasses ride-to-ride transfer buffers and boarding restrictions at intermediate stops. Only emit a stop arrival label when drop-off permits alighting. Keep enough incoming route/trip/platform context to evaluate specific transfer rules; one earliest label per station is insufficient for all constrained transfers.
5. Apply real-time at stop-event level before scanning. Cancelled runs cannot be boarded; skipped events disallow boarding/alighting. A connection uses the departure update of its departure sequence and the arrival update of its arrival sequence. Do not apply one delay to both endpoints indiscriminately. **Re-sort/re-merge by effective departure times** after updates; static page order/bounds alone no longer establish real-time ordering. Expand the search interval for delays and additional trips.
6. Retain predecessors to reconstruct ride legs; combine contiguous connections of the same dated run, retaining intervening calls/dwell time. Look up labels, platforms, headsigns, composition segments, occupancy and alerts only after selecting alternatives. For arrive-by, reverse the scan and constraints; profile or multi-label algorithms supply alternatives and transfer counts. A single earliest-arrival scan does not reproduce RIV's ranking.
7. Fetch shapes only for displayed legs; align using ordered call sequences/distances. Show scheduled versus estimated times distinctly and preserve unknown/stale provenance.

GTFS pickup/drop-off code 1 forbids boarding/alighting, but allows staying on board; codes 2/3 require arrangements. The simple demo only boards/alights code 0, and does not implement conditional booking. Respect transport filters, forbidden transfers, accessibility and linked-trip/frequency rules explicitly. Do not assume geographical proximity proves a walkable transfer.

The runnable [example](../examples/plan.mjs) demonstrates one static forward query, with same-run continuity and station transfer buffers, against the generated fixture. It does not implement real-time, walking, platform-specific transfer selectors, profile alternatives or arrive-by. A complete planner implements the constraints above and the acceptance checks in [PLAN.md](../PLAN.md).

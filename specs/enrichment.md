# Occupancy, alerts and stop status

These tables cover current iRail behavior that a schedule and basic GTFS-RT feed may not provide. The executable fixture contains empty occupancy/alert tables marked unavailable; the reserved stop-status contract is not collected yet. Source adapters must declare what is present, stale, absent and unresolved.

## `occupancy.arrow`

Crowdedness is an independent dataset containing observations and forecasts. Keep one latest record per `(callIri, sourceIri)`; `(tripIdx, serviceDate, stopSequence, source)` accelerates that key only within the matching static release. Official observations, user feedback and versioned forecasts have separate sources. Fields:

| Fields | Arrow type | Nullable | Meaning |
| --- | --- | --- | --- |
| `tripIdx` | Int32 | no | Trip row |
| `serviceDate`, `stopSequence` | Uint32 | no | Dated departure event |
| `level` | Utf8 | no | `low`, `medium`, `high`, `unknown` |
| `score` | Float32 | yes | Ordinal 0, 0.5, 1 when known; not load percentage |
| `source` | Utf8 | no | `sncb-riv`, `irail-user`, versioned aggregate/model, etc. |
| `observedAt` | Int64 | no | UTC observation or model-generation seconds, distinct from the targeted call's scheduled time |
| `expiresAt` | Int64 | yes | UTC expiry seconds, null only when source has no declared expiry |

The complete schema also requires `iri`, `callIri` and `sourceIri` (Utf8); see [the ordered reference](arrow-schemas.md#occupancyarrow). Join `occupancy.callIri` to `connectionEnrichment.departureCallIri`, or match `(tripIdx, serviceDate, stopSequence)` to the departure endpoint of an LC connection. Consumers reconstruct stop visits from connection endpoints; no calls file is published. Never join by row position across releases. Numeric joins require the occupancy manifest's `staticReleaseId` to match the pinned timetable. A forecast targets the same dated call as a live observation; its source identifies the model and version, and `observedAt` records when the model generated it.

Preserve observed unknown separately from no observation. Known levels `low`, `medium`, `high` correspond to scores 0, 0.5, 1; `unknown` has a null score. Scores are ordinal costs, not measured load fractions. The SNCB RIV mapping in this specification is 1 → low, 2 → medium, 3 or 4 → high; unrecognized values remain unknown and should be counted. A forecasting model must version its mapping and document its horizon/confidence separately. Aggregating user reports needs a versioned policy and should preserve official versus community provenance. User report ingestion remains a separate write service with persistent storage. These public files need no reporter identifiers.

Publish occupancy snapshots independently from GTFS releases, with their own source/generation/expiry metadata as described in [publication](publication.md#overlay-discovery). A consumer discards expired records and states its policy for choosing a fresh observation or a forecast. Missing, expired or explicitly unknown crowdedness stays unknown, never an empty-train score. Ranking by crowdedness can load the overlay before evaluating alternatives; display-only clients can join it after planning. Neither observations nor forecasts are embedded in LC connection pages, so collecting or updating crowdedness does not change the GTFS build or its hashes. The scaffold currently publishes only an empty typed occupancy fixture marked unavailable; collection and independent snapshot publication remain planned.

## `alerts.arrow`

One current translation per `(alertId, language)`. IDs must be namespaced by upstream source to avoid collisions.

| Fields | Arrow type | Nullable | Meaning |
| --- | --- | --- | --- |
| `alertId`, `language` | Utf8 | no | Namespaced source ID, language tag (NL/FR/DE/EN represented as `nl`/`fr`/`de`/`en`) |
| `type` | Utf8 | no | `info`, `trouble`, `works`, or preserved source-specific category |
| `header`, `lead`, `description`, `company` | Utf8 | yes | User-visible text and issuer |
| `linksJson` | Utf8 | yes | JSON array of `{ "url": string, "name": string|null }` |
| `validFrom`, `validTo`, `modifiedAt` | Int64 | yes | UTC seconds; validity is `[from,to)` with null as open/unknown bound |
| `source` | Utf8 | no | E.g. `sncb-rss` / `sncb-riv` / `sncb-gtfs-rt` |
| `observedAt` | Int64 | no | UTC fetch/observation seconds |

Sanitize source markup to text; rendering applications escape it. Keep valid-time and fetch-time distinct. RSS publication time must not be invented as an alert's start/end if the source lacks validity. Complex GTFS-RT active periods/effects remain preserved in the raw `service-alerts.pb`; a normalized exporter splits periods or explicitly declares its simplification.

## `alert-entities.arrow`

Non-null `alertId: Utf8`, nullable `stopIdx`, `routeIdx`, `tripIdx: Int32`, `serviceDate`, `stopSequence: Uint32`. Each row is a conjunction of its non-null selectors; multiple rows are alternatives. `stopSequence` requires a dated trip. All-null selectors mean network-wide/unspecified scope and should be displayed as such, not guessed from message text. An RSS alert without selectors can still be useful on a disturbances page. Join translations by alert ID and select language with a documented fallback. Source references to unknown entities belong in diagnostics rather than arbitrary matching.

## `stop-status.arrow` (reserved)

One current record per `(tripIdx, serviceDate, stopSequence, source)`. Exact fields in `schemas.mjs` under `stopStatus`:

| Fields | Arrow type | Nullable | Meaning |
| --- | --- | --- | --- |
| `tripIdx` | Int32 | no | Trip row |
| `serviceDate`, `stopSequence` | Uint32 | no | Scheduled event key |
| `arrivalPlatform`, `departurePlatform` | Utf8 | yes | Current reported labels, compared with scheduled stop platform |
| `arrivalCancelled`, `departureCancelled` | Bool | yes | Independently reported partial cancellation flags |
| `isExtra` | Bool | yes | Reported additional service flag for a matched event |
| `arrivalState`, `departureState` | Utf8 | yes | E.g. `reported`, `approaching`, `halting`, `left`; only report source-supported states |
| `notesJson` | Utf8 | yes | JSON array of source note strings |
| `source` | Utf8 | no | Source namespace |
| `observedAt` | Int64 | no | UTC observation seconds |

Null cancellation is unknown, false is explicitly not cancelled. Do not infer `reported` from the clock having passed. Preserve arrival and departure labels separately. A changed label can be compared with the scheduled platform to derive `platform.normal`; missing data cannot establish that the platform is normal. [RIV reconciliation](riv.md) defines per-field source/time selection and expiry. A whole-run cancellation must be compared with evidence at the same scope: a single RIV stop flag cannot silently clear it, while explicitly newer complete RIV run/segment evidence must not be ignored merely because GTFS-RT is canonical for its own feed. Retain disagreements and scopes for reconciliation.

This indexed table cannot itself introduce an unindexed new train. Such events require the future additional-service contract, with the original source response retained for reconciliation.

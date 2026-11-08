# Global identifiers, `irail-global-v1`

Use the same public IRI for the same entity in Arrow, normalized RIV and GTFS-RT, RDF and the LDES. Arrow dictionary indices remain local scan accelerators. A release ID, page path, fetch timestamp, delay or current platform is never part of a stable entity IRI.

The shared implementation is [src/iri-strategy.ts](../src/iri-strategy.ts), with convenience methods in [src/identifiers.ts](../src/identifiers.ts) and a complete, executable registry in [config/sources.json](../config/sources.json). The default identity authority is `https://irail.be/id`. Builders and collectors use the same templates and mappings, independent of file partitioning or deployment hostname.

## Identity authorities and delivery URLs

| Setting | Purpose and stability |
| --- | --- |
| `identityBase` / `ID_BASE_URL` | Owned HTTP(S) identity namespace, default `https://irail.be/id`. Keep stable across development, previews and production. |
| Source-specific `identityBase` | Override for an operator with its own identity authority; source key still appears in default templates. |
| Named `bases` | Explicit established authorities, such as `http://irail.be/stations/NMBS`. Templates select the appropriate authority per entity kind. |
| `PUBLIC_BASE_URL` | Public delivery base, default `https://cdn.irail.be`; controls `/feed`, pages and `/updates/<sequence>` version IRIs. Local development can use `http://localhost:8787`. |
| Release/object paths | Immutable byte locations discovered through manifests; never entity identities. |

Changing the delivery host leaves entity IRIs unchanged. A stream's version IRIs belong to its publication: moving `PUBLIC_BASE_URL` creates a new publication identity unless the old URL remains canonical. Production publishers must use an identity authority they control or have permission to publish under. The bundled defaults describe the intended iRail deployment; independent deployments choose their own base before first publication, preserving established external references where appropriate.

## Namespace and key rules

- A registered source key names a logical operator/identifier space: `be.sncb`, later e.g. `nl.ns` or `be.delijn`. It is not `riv`, `gtfs` or the name of a mirror. SNCB's GTFS-static, GTFS-RT, RIV and RSS collectors all map into `be.sncb`. `demo.fixture` is reserved for synthetic data.
- Keys have lower-case registry syntax `[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*`. Entity kinds have separate fixed path components. Raw values are opaque, case-sensitive strings. Encode each entire key as one RFC 3986 path component exactly once. `/`, `%`, `?`, `#` and Unicode cannot create extra path segments; `a/b` and literal `a%2Fb` remain distinct. Empty/dot-only keys are rejected.
- The mapper supplies a persistent entity key. A raw GTFS `trip_id` can serve as that key only when its source stability is known. Persist a curated raw-ID-to-key mapping across static releases when feeds renumber entities. If a source recycles a raw ID for a different entity, mint a new key. Do not pretend public train number alone identifies a trip template.
- Keep original external IDs and aliases alongside the IRI. `releaseId` scopes integer indices and source-feed versions, not canonical identity. Raw ID joins require a matching feed generation even though the resulting mapped IRI is release-independent.

## Default templates

Let `B=https://irail.be/id`, `S=be.sncb`, and each `<key>` be one escaped component.

| Entity | IRI |
| --- | --- |
| Operator/source | `B/S/source` |
| Collection channel | `B/S/providers/<channel>` (e.g. `riv` or `gtfs-rt`) |
| Stop/platform | `B/S/stops/<stop-key>` |
| Independently identified station without an established external IRI | `B/S/stations/<station-key>` |
| Agency, route, trip template | `B/S/agencies/<key>`, `B/S/routes/<key>`, `B/S/trips/<key>` |
| Dated run | `B/S/runs/<trip-key>/<YYYYMMDD>` |
| Call | `B/S/runs/<trip-key>/<YYYYMMDD>/calls/<original-sequence>` |
| Connection departing that call | `B/S/runs/<trip-key>/<YYYYMMDD>/connections/<departure-sequence>` |
| Shape and physical unit | `B/S/shapes/<key>`, `B/S/units/<unit-key>` |
| Other entities | Separate kinds such as `alerts`, `compositions`, `occupancy`, `transfers`, `shape-points`; persistent keys derive from the full logical tuple, never a row offset |

A run is dated using the original service date, including after-midnight events. Actual time changes cannot change its identifier. Frequency runs need an instance discriminator; builders must expand them to distinct persistent trip keys or declare them unsupported. Repeated stops use original sequences, not station identity, in call/connection keys.

## `be.sncb` IRIs in the production build

[config/sources.json](../config/sources.json) takes these IRIs from the iRail API (`be.irail.api.util.IrailUri`, `LinkedConnectionsService`, `Stop.getHafasId`): stations `http://irail.be/stations/NMBS/00<hafas>` (verified station parents only), vehicles `http://irail.be/vehicle/<route short name><trip short name>`. Runs, calls, connections, trips, routes, stops and agencies stay under `https://irail.be/id/be.sncb/`. The API's historical connection IRI `http://irail.be/connections/<hafas>/<departure date>/<vehicle>` and vehicle run IRI `http://irail.be/vehicle/<vehicle>/<date>` are **not** minted as entity IRIs: the 7 November 2026 feed has several scheduled trips with the same vehicle number on one day (IC 5130 from Bruxelles-Midi, for instance), and the registry rejects the resulting collision. The vehicle IRI is exposed as `tripEnrichment.vehicleIri`, where it can be shared by several trips. Minting `be.sncb` `vehicle`, `run` or `connection` IRIs needs dictionary context (route/trip short names); collectors obtain it from the pinned release rather than from the key alone.

## Configuration and expansion

The registry has `strategyVersion: 1` (configuration grammar), `identityProfile: "irail-global-v1"` (identity contract), `identityBase`, `timeZone`, `bases`, `templates`, `resolve` and `sources`. These are separate from the Arrow format's version number. The checked-in registry contains every default template, including source, provider, station, agency, route, trip, run, call, connection, shape, unit and generic entity.

Each source can override `identityBase` and `timeZone`. Its `bases`, `templates` and `resolve` maps merge by name over the global maps; a replaced template/resolver replaces that complete value. Defaults are UTC, with `Europe/Brussels` for `be.sncb` and the fixtures. Source metadata also declares collection channels and the station profile. A new operator needs a unique registry key; the helper permits syntactically valid unregistered keys for experimentation, while production builders must require registry membership.

An illustrative source entry, added under `sources`, can select an existing station authority and derive opaque station keys:

```json
"demo.custom": {
  "name": "Illustrative operator",
  "channels": ["gtfs-static", "gtfs-rt"],
  "identityBase": "https://ids.example/rail",
  "timeZone": "Europe/Amsterdam",
  "bases": { "stations": "https://stations.example/nl" },
  "templates": {
    "stop": "{bases.stations}/{stopCode}",
    "trip": "{base}/{sourceId}/trips/{trips.trip_id}"
  },
  "resolve": {
    "stopCode": { "padStart": {
      "value": { "coalesce": ["stops.code", "stops.stop_id.substring(2)"] },
      "length": 5,
      "fill": "0"
    } }
  }
}
```

For this example, `stops.stop_id = "NL12"` expands to `https://stations.example/nl/00012`. Supplying `stops.code = "12"` yields the same IRI. Mapping both inputs to the same logical key is the producer's responsibility. `trips.trip_id = "IC/123"` expands to `https://ids.example/rail/demo.custom/trips/IC%2F123`; using raw trip IDs requires the stability guarantees described above. A custom template that omits source/kind discrimination must use an independently unique authority/key and pass the shared collision check.

Templates are HTTP(S) path templates, not executable code or general RFC 6570 expressions. `{base}` and `{bases.<name>}` insert validated bases at the start of a template; `{sourceId}` inserts the registered source key. Every other `{path}` inserts one escaped scalar path component, including resolver results. Prefixes and `/` separators are literal configuration, and supplied values cannot create additional path structure. Bases cannot include credentials, query strings or fragments. Missing values, empty/dot-only keys, malformed templates, unsupported resolver expressions and non-normalized final URLs fail publication. No fallback to a row number or a string containing `undefined` is allowed.

The input context uses these roots; producers can retain additional raw fields under each record:

| Root / field | Meaning |
| --- | --- |
| `stops`, `routes`, `trips` | Current source records plus persistent normalized `key`; raw fields such as `stop_id`, `route_id`, `trip_id` are available when supplied |
| `connection.serviceDate` | Original service day, `YYYYMMDD` or `YYYY-MM-DD`; not a UTC departure date |
| `connection.stopSequence` | Original nonnegative Uint32 departure/call sequence |
| `connection` | May additionally carry original scheduled times and departure/arrival fields for explicitly configured resolvers |
| `agency`, `shapes`, `unit`, `provider` | Entity records; defaults use `key` |
| `entity.kind`, `entity.key` | Generic family and persistent key for alerts, compositions, transfers and other entities |
| `stops.uic` | Verified station code for the SNCB station profile |

Resolver names are additional top-level placeholders. A resolver may depend on another resolver; cycles fail. Field access is restricted to own properties and rejects prototype access. No `eval`, JavaScript functions, imports, network lookups or implicit environment access are supported.

| Resolver form | Semantics |
| --- | --- |
| `"trips.key"` | Read a context path or resolver alias |
| `"stops.stop_id.substring(2, 7)"` | String substring, zero-based start inclusive/end exclusive; end optional |
| `"format(connection.serviceDate, 'yyyyMMdd')"` | Deterministic calendar formatting |
| `{ "literal": "rail" }` | Literal scalar |
| `{ "coalesce": ["stops.code", "stops.stop_id"] }` | First present, non-null, nonempty value; invalid expressions still fail |
| `{ "concat": ["unit.fleet", { "literal": ":" }, "unit.number"] }` | Concatenate scalar values before component escaping |
| `{ "padStart": { "value": "stops.uic", "length": 9, "fill": "0" } }` | Left-pad to a minimum length; never truncate |

String expressions may have one trailing semicolon. Date patterns support `yyyy`, `yy`, `MM`, `dd`, `HH`, `mm`, `ss`, punctuation and single-quoted literals. In a JSON expression, `"format(trips.startTime, 'yyyyMMdd\\'T\\'HHmm');"` inserts a literal `T`. Service dates retain their calendar day and have midnight time components; instants must be `Date` objects or ISO date-times with `Z`/an explicit offset and are formatted in the configured source timezone. Timezone-free date-times and Unix timestamp numbers are not accepted as instants. Use the original service day for canonical run/call/connection IDs; delayed, rerouted and after-midnight events keep their identity.

### Shared minting and collision detection

```ts
import { identifiers, createIriStrategy, defaultIriConfiguration, IriRegistry }
  from './src/identifiers.ts';

const registry = new IriRegistry(); // Share across all tables and sources in a build.
const ids = identifiers('be.sncb', defaultIriConfiguration, registry);
ids.call('IC518', 20261107, 10);
// https://irail.be/id/be.sncb/runs/IC518/20261107/calls/10

const strategy = createIriStrategy('be.sncb', defaultIriConfiguration, registry);
strategy.mint('call', {
  trips: { key: 'IC518' },
  connection: { serviceDate: '20261107', stopSequence: 10 }
}, ['IC518', '20261107', 10]); // Same logical tuple and same IRI.
```

Convenience methods supply the normalized keys used by default templates. Use `mint(kind, context, identityKey)` when a custom template needs additional raw records. `identityKey` is a nonempty tuple of persistent scalar keys, scoped internally by source and template kind; it is independent of the template's spelling. A repeated claim is allowed only for the same logical tuple and IRI. The registry rejects different logical entities minting one IRI and a logical entity changing IRI within the registry's lifetime. Reuse it across all source strategies in a build. It is an in-memory validator; production publishers must persist/reload logical mappings and verify them against previous releases to detect drift across runs.

Both builders and Worker code import the bundled configuration. `iriConfiguration(env)` optionally reads a full replacement registry from `IRI_STRATEGY_JSON`; `ID_BASE_URL` overrides its global `identityBase`, while explicit per-source bases still win. These settings are public identity configuration, not secrets. Runtime GTFS-RT discovery includes the effective snapshot, `sourceIri` and `providerIri`; raw protobuf bytes retain upstream IDs. Static fixture generation uses the bundled registry and publishes `identity-strategy.json` with an iRail extension-manifest descriptor and SHA-256 hash. A production builder using an override must pin those actual effective rules rather than the bundled defaults. The snapshot includes merged templates, resolvers, bases, timezone, source key, profile and grammar version. Consumers can replay it with `createIriStrategy(snapshot.sourceId, { ...snapshot, sources: {} })`.

Consumers join published IRIs directly; they need not reconstruct them from raw IDs. On a template/base/key-policy change affecting existing IRIs, introduce a new identity profile, retain old aliases and explicitly migrate/reconcile entities. Adding an operator without changing existing IRIs can retain the profile. Pin the rules used for each release, including the curated raw-ID mappings once implemented. A configuration digest alone cannot prove that upstream raw IDs remained stable.

### Preserve established iRail station IRIs

For a **verified SNCB station** with seven-digit UIC/HAFAS value `8814001`, retain `http://irail.be/stations/NMBS/008814001`. The station profile is named `irail-nmbs`: take the verified seven-digit station code, prepend `00`, and append those nine digits to `http://irail.be/stations/NMBS/`. The helper also accepts the already-prefixed nine-digit form and preserves the existing `http` scheme. Platform children get distinct stop IRIs and reference the canonical station through `stationIri`/`parentIri`. Do not collapse all platform or international IDs based on a numeric-looking suffix.

`http://irail.be/vehicle/IC518` remains a useful legacy public-service alias, distinct from a dated run or physical carriage. The existing `http://irail.be/connections/<station>/<date>/<vehicle>` convention lacks an original stop sequence and may collide for loops; keep it only as an explicitly mapped legacy alias. Do not make it the new canonical connection key. RIV journey detail refs are short-lived locators and never canonical identifiers.

Every builder and source adapter implements the templates and station profile defined in this document. Publish a future `identifiers.arrow` mapping canonical IRI, source/channel, raw ID, entity kind, feed validity and legacy aliases once that extension's schema is specified. Cross-operator stations become shared only through an explicit curated reconciliation; neither equal numeric IDs nor nearby coordinates justify `owl:sameAs`.

## Arrow references

Core `connections`, `stops`, `trips` and `routes` each have their LC `iri`; core transfers use nullable selectors without an IRI column. Rich relationship fields live in the iRail side tables below, non-null unless marked `?`. [The complete ordered schema reference](arrow-schemas.md) and [schemas.mjs](schemas.mjs) define types and order.

| Table | Canonical identity / relationships |
| --- | --- |
| connection enrichment | Core connection `iri`, `tripIri`, `runIri`, `departureStopIri`, `arrivalStopIri`, `departureCallIri`, `arrivalCallIri` |
| stop enrichment | Core stop `iri`, `stationIri?`, `parentIri?` |
| trip enrichment | Core trip `iri`, `routeIri`, `shapeIri?`; `vehicleIri?` remains a display alias |
| route enrichment | Core route `iri`, `agencyIri` |
| transfer enrichment | Rule `iri`; stop/trip/route selector IRIs nullable, joining through `transferIdx` |
| shapes / shape points | `iri`; points additionally `shapeIri` |
| compositions | `iri`, `tripIri`, `runIri`, `fromCallIri`, `toCallIri`, `sourceIri`; `unitIri?` |
| occupancy | `iri`, `callIri`, `sourceIri` |
| alerts / alert associations | Alert `iri`, `sourceIri`; association `iri`, `alertIri`, optional stop/route/trip/run/call IRIs |
| stop status | `iri`, `callIri`, `sourceIri` |
| delays/cancellations | `iri`, `tripIri`, `runIri`, `sourceIri`; `callIri?` (null for trip scope), `assignedStopIri?` |

These event references do not introduce a calls dataset. Consumers match connection endpoints by dated trip/sequence and reconstruct ordinary stop visits. Raw IDs are retained in stop/trip/route enrichment, rather than added as required LC fields. A native LC GTFS-RT link requires RFC 6570 templates reproducing core IRIs exactly; the richer configuration described here remains separate for lookup-based reconciliation.

An index and its IRI must identify the same dictionary row; reject disagreement before publication. A standalone overlay can join by IRI across releases; use its numeric indices only when `staticReleaseId` also matches. Dictionary reorder tests must not change canonical identity. IRIs can be dictionary-encoded by a future compatible writer to reduce repeated bytes, with the declared Arrow schema adjusted deliberately; the current contract uses plain Utf8.

This identity profile is independent of the LC2-alpha and iRail extension schema versions. The synthetic release ID `demo-lc2-alpha` identifies fixture data, not a prior deployed format. Resolving the identity authority's HTTP URLs to canonical descriptions is a publication task (content negotiation/redirects and alias management); minting an IRI alone does not implement dereferencing on irail.be.

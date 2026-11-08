# Twelve-hour LDES 2.0 feed

Collectors share one LDES 2.0 publication of the updates they observe. Multiple deployments are optional. The scaffold starts with a public Worker plus two SQLite-backed Durable Object classes in the same deployment: `RivGateway` owns the RIV credential/cache/budget; `ChangeJournal` owns one durable change log. Collection can later move into several Workers/queue consumers while retaining those central owners.

`GET /feed` targets the **LDES 2.0 working-draft message and interval model**. The exact publication profile is specified below and illustrated in [the compressed Jelly example](examples/feed.jelly.zst), its [continuation](examples/feed.next.jelly.zst) and [reproducible generator](../examples/feed-page.mjs). Its protocol uses the `https://w3id.org/ldes#` vocabulary for pages, membership and relations. This target is independent of the LC2-alpha and iRail extension schema versions.

The endpoint has one representation:

| HTTP property | Value |
| --- | --- |
| `Content-Type` | `application/x-jelly-rdf;profile="https://w3id.org/ldes/specification"` |
| `Content-Encoding` | `zstd` |
| Saved filename | `feed.jelly.zst` |
| Decompressed data | Delimited Jelly-RDF **1.2**, protocol tag 3, with `RdfStreamType.MESSAGES` and explicit logical RDF Message boundaries |

Use `Accept: application/x-jelly-rdf` and `Accept-Encoding: zstd`. An absent/wildcard `Accept` also selects Jelly. Quality values and explicit exclusions are respected; clients that exclude Jelly or Zstandard receive 406. All pages use one ordinary Zstandard frame (level 3 with checksum, no external dictionary); compression is outside the length-delimited Jelly stream. The media type describes the decompressed representation. There is no second serialization or identity-encoded fallback. Responses include `Vary: Accept, Accept-Encoding` and `Cache-Control: no-cache, no-transform`. The Worker uses Cloudflare's original [`cf.clientAcceptEncoding`](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties) when the network normalizes that request header.

[RDF Messages](https://w3c-cg.github.io/rsp/spec/messages) defines the message model; [Jelly](https://jelly-rdf.github.io/dev/specification/serialization/) defines the binary encoding. Logical message boundaries are independent of compression frames or binary batches: decompress first, then parse complete Jelly messages. A member remains one message even when packing or batch splitting changes its physical encoding.

**Current boundary:** the generic journal, retention, producer RPC and HTTP/Jelly delivery work and are tested with normalized synthetic updates. Scheduled GTFS-RT still only mirrors raw protobuf. The RIV endpoint parsers/jobs and static-ID reconciliation are not wired into the journal yet. `/feed` therefore starts empty until an internal producer submits normalized observations. Neither enabling GTFS-RT nor setting a RIV key currently claims a complete SNCB updates feed.

## Producer contract

All producers call the same journal object `all-updates` through the `UPDATES` binding:

```ts
const journal = env.UPDATES.get(env.UPDATES.idFromName('all-updates'));
await journal.ingest([{
  observationId: 'urn:collector:be.sncb:riv:response-hash:call-10',
  entityIri: ids.call(tripKey, serviceDate, 10),
  sourceIri: ids.provider('riv'),
  observedAt: originalFetchedAt,
  statements: [{
    predicate: 'http://semweb.mmlab.be/ns/linkedconnections#departureDelay',
    object: { type: 'literal', value: '120', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }
  }]
}]);
```

An observation is a **complete state of that entity's source slot**, not an unlabelled partial patch. Producers choose separate source slots/channels when their observations cover different subsets, or first reduce patches into one full source state. `observationId` is a stable, unique delivery identifier reused on retries; compute it from source generation/response identity plus target entity. `observedAt` is the original source/collection instant (preserve original fetch time on cache hits). `deleted: true` explicitly retracts that source slot; it does not mean train cancellation. Statements use absolute predicate/IRI objects or typed/language-tagged literals. Internal metadata predicates are reserved.

The journal keys its previous state by `(entityIri, sourceIri)`, canonicalizes property order, compares semantic state without fetch time, and appends only a changed state. It remembers last states beyond log retention, so identical polls do not become new events merely because old history expired. `A → B → A` produces three versions with distinct IDs, even though the final content hash repeats. Replayed delivery IDs are deduplicated; reuse for different content fails. Older source observations are ignored; conflicting states at exactly the same observation time are rejected as stale rather than arbitrarily reordered. Persist a source-order discriminator in a future adapter if its feed legitimately issues corrections with equal timestamps.

The journal reserves a monotonic sequence and persists events, idempotency receipts and latest source states atomically. LDES chronological time is the journal commit time (nondecreasing even if wall time moves backwards), while source observation time is separate. This prevents a late-arriving source update from violating LDES chronological append order. A batch is limited to 100 observations/512 KiB, each payload to 16 KiB. Producers chunk larger generations and acknowledge their source checkpoint only after all durable batches succeed; there is currently no public ingestion route and no cross-batch transaction protocol.

## RDF model and canonical entities

The stream IRI is `PUBLIC_BASE_URL/feed#stream`; dereferencing it fetches the root page `PUBLIC_BASE_URL/feed` after the fragment is removed. The stream is typed `ldes:EventStream` and `dcat:Distribution`. Each HTTP page is an `ldes:Page`. The stream identity denotes this ordered publication and retention policy, while the page identity denotes one HTTP resource.

Each page contains one non-empty **description message first**, followed by zero to 100 non-empty **member messages**. An empty feed still contains its description. Description messages contain page relations; the root also declares the stream's ordering, membership, versioning, polling interval and retention policy. Queried subsequent pages retain their page identity and relations; consumers keep the context from the root.

The root declares these paths:

| Property on the stream | Value and meaning |
| --- | --- |
| `ldes:timestampPath` | `dcterms:created`, the journal commit timestamp |
| `ldes:sequencePath` | `https://irail.be/vocab/sequence`, the monotonically increasing integer that breaks timestamp ties |
| `ldes:memberPath` | `dcterms:created`, identifying the only subject with that property in each member message |
| `ldes:versionOfPath` | `dcterms:isVersionOf`, linking each version to its canonical entity |
| `ldes:versionUpdateObject` | `as:Update`, an upsert; the default discriminator path is `rdf:type` |
| `ldes:versionDeleteObject` | `as:Delete`, an explicit source-state retraction; the default discriminator path is `rdf:type` |
| `ldes:pollingInterval` | `60` seconds as `xsd:integer` |

This profile uses **indirect membership**. Every member message has exactly one subject with exactly one `dcterms:created` value. The complete set of quads in that message is the member data; consumers do not recursively extract data from a page-wide graph. A member message describes its version and payload, while protocol descriptions stay in the description message. No empty messages or multiple members in one message are allowed. Member order is ascending by `(commit timestamp, sequence)`.

Each immutable member has an IRI `PUBLIC_BASE_URL/updates/<sequence>`, `dcterms:isVersionOf` the entity's public IRI, `dcterms:created` the commit timestamp, `prov:generatedAtTime` the source/collector observation time, `prov:wasAttributedTo` its source-channel IRI, and the payload properties on the version subject. Retractions are typed `as:Delete`; other versions are upserts (`as:Update`). The stream advertises those paths, and `irail:sequence` supplies tie ordering.

RIV and GTFS-RT observations of the same canonical call retain separate provenance. This is an **observation stream**: a generic consumer that overwrites the entity with the last member regardless of source would lose that distinction. Fold by entity + source, then apply the documented per-field resolver. A production extension can expose a separate resolved-state LDES/view in which every member is the complete effective entity and `versionOfPath` alone suffices. Do not mix partial observations and complete effective versions without an explicit model/view distinction.

Normalized connection versions will use the exact `planning.iri` and call relationships, scheduled event identity, effective arrival/departure estimates, separate delays/cancellation flags, platform and source provenance. Composition, occupancy, alerts and station changes use their own canonical IRIs and entity types. Adding an observation must not mint a new train identity just because its delay/platform changed. Diffing stays independent of Arrow page layout and dictionary reorderings.

## Retention and traversal

The root description attaches `ldes:retentionPolicy` to the **stream**. Its `ldes:RetentionPolicy` advertises `ldes:fullLogDuration "PT12H"^^xsd:duration` and `ldes:startingFrom` the journal initialization time. Retention is based on **commit time**, not train departure time or upstream measurement time. All changed states committed in the last 12 hours are available; data before that window is not promised. Reads filter and prune expired members; an alarm also cleans up after producers go quiet. Last-source-state fingerprints are retained separately and are not exposed as historical members.

Pages link through `ldes:relation` to an `ldes:Relation` with exactly one `ldes:page` target. Pagination targets use `/feed?after=<last-sequence>&until=<watermark>`. Every continuation advertises a closed-open interval `[from, until)` of the full ordering key:

| Relation property | Type | Meaning |
| --- | --- | --- |
| `ldes:page` | IRI | The HTTP page to fetch |
| `ldes:timeFrom` | `xsd:dateTime` with timezone | Inclusive lower timestamp |
| `ldes:sequenceFrom` | `xsd:integer` | Inclusive sequence at that timestamp |
| `ldes:timeUntil` | `xsd:dateTime` with timezone | Exclusive upper timestamp component |
| `ldes:sequenceUntil` | `xsd:integer` | Exclusive sequence at that timestamp |

Compare pairs lexicographically: compare times first, and compare sequences when the times are equal. A sequence bound always has the corresponding timestamp bound because this stream declares both ordering paths. The lower pair is the first member on the next page; the exclusive upper pair uses the captured watermark member's timestamp and its sequence plus one. This remains correct when a page boundary splits members with an identical timestamp. Bounds apply to every member reachable by following the relation, including further continuations. The LDES model also permits omitted/open bounds, but this provider supplies both pairs for its bounded traversals.

The server caps a requested `until` at the current high watermark and carries that fixed watermark into every subsequent page, excluding later commits from that traversal. A client initializes from `/feed` or `/feed#stream`, reads the description, processes member messages, and follows the relevant `ldes:page` targets. It retains its last ordering key and the member IDs at that key; this provider's globally unique sequences also permit polling `/feed?after=<last-sequence>` with retained root context. A new client starts at the root rather than treating a queried continuation as an independent entry point.

Retention continues during traversal. A client paused beyond the 12h window must bootstrap a static release plus current overlays rather than assume the log contains a full snapshot. Publication status and lag per producer remain necessary for coverage claims.

Pages use `Cache-Control: no-cache, no-transform` with ETags over the compressed bytes. Clients can revalidate with `If-None-Match`; an unchanged representation returns 304. Pages are not marked immutable because retention can remove expired members. Retained member content never changes. Twelve hours is this publication's retention policy, not unbounded archival storage. The `/updates/<sequence>` IRIs identify members within the stream; separate member dereferencing is a planned endpoint.

Read locally:

```sh
curl -H 'Accept: application/x-jelly-rdf' -H 'Accept-Encoding: zstd' \
  http://localhost:8787/feed -o updates.jelly.zst
zstd -d updates.jelly.zst -o updates.jelly
```

`npm run example:feed` reproduces the two checked-in example pages. They contain synthetic updates and a source-slot retraction; the first page links to the second through a bounded LDES relation.

This curl command saves wire bytes; `curl --compressed` instead decodes them when the installed curl supports Zstandard. Browser `fetch` automatically decodes supported HTTP content encodings, so pass its decoded body directly to a Jelly parser. A client reading a saved `.jelly.zst` file must decompress it explicitly. Do not decompress twice based only on a response header retained by a fetch implementation. In Node 24+, saved bytes can be decoded with `zstdDecompressSync` from `node:zlib`; for large streams use streaming decompression.

For bounded inspection or tests, use `Parser.parseMessages()` in `rdfjs-jelly`, or `rdfjs-jelly/browser` in a browser. Production clients decompress and parse incrementally with a message-aware stream parser, processing complete messages as they arrive. The current server buffers bounded pages of at most 100 members before compression. Treat the first message as the page description and each remaining message as one member. Identify members through `ldes:memberPath`, and inspect `ldes:relation` / `ldes:page` with their bounds for traversal. A flattened triple parser discards the boundaries needed by LDES 2.0. Copy `.dev.vars.example` for local `PUBLIC_BASE_URL=http://localhost:8787`; the deployed value must be the stable public serving origin. Entity IRIs follow the separate [identity configuration](identifiers.md), regardless of the feed's serving host.

## Production topology and reliable hand-off

Recommended roles: **collector Worker(s)** (GTFS-RT, RIV, RSS, static publication jobs), **journal/resolver owner Worker** (shared `RivGateway`, `ChangeJournal`, source-state reduction), and **public delivery Worker** (Arrow/protobuf/Jelly routes). Initially they may share one deployment. Additional instances alone do not increase the RIV credential's permitted request budget.

Use private service/DO bindings or Cloudflare Queues, not public unauthenticated POST endpoints. Queue delivery is at least once, so retain observation IDs and checkpoint/outbox records. Producers must persist a pending normalized generation before advancing their checkpoint, retry until journal acknowledgment, and materialize/publish Arrow manifests from committed state. Avoid the failure mode where a collector updates its local “last seen” snapshot, crashes before emitting, and permanently loses that change. Upstream retrieval, R2 uploads and journal commits are not one distributed transaction.

Before production, add source normalizers, durable per-producer checkpoints, conflict/coverage metrics, a resolved view, bounded materializers, identifier resolution, persistence/restart tests and load measurements. A single journal provides one ordering authority. If measured volume requires independent shards, give each shard its own LDES distribution IRI, shard-qualified version IRIs and cursor, and describe those distributions in a catalog. Publishing them as one ordered stream would require a shared ordering coordinator. If pages are later sealed to R2, retain them for 12h plus a traversal/cache safety margin, with late-arrival handling and a durable publication outbox.

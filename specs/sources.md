# Data sources, cadence and products

Overview of what the iRail API consumes and what this provider publishes from it. "Sampled" means checked against live data on 8 November 2026; the rest comes from the iRail API source and [riv.md](riv.md).

| Source | Access | Cadence | Products | State |
| --- | --- | --- | --- | --- |
| GTFS static | Public archive URL (`config/sncb.json`) | daily | LC connections and reference tables, stations, platforms, headsigns | **done**, GitHub Pages |
| GTFS-RT TripUpdates | Open feed `sncb-opendata.hafas.de/gtfs/realtime/…`, no key (sampled). iRail's production config uses FlatTurtle's token-protected mirror of the same data. | upstream refreshes every ~30 s | Latest raw protobuf on the CDN; later `delays-cancellations.arrow` and platform assignments | **publisher built**: [Cloudflare setup](../docs/cloudflare-setup.md) |
| RSS disturbances | `belgianrail.be/jp/sncb-nmbs-routeplanner/help.exe/{nl,fr,en,de}?tpl=rss_feed`, no key | minutes | `alerts.arrow`, `alert-entities.arrow` in four languages; selectors are not guessed from missing data | next |
| RIV API | `mobile-riv.api.belgianrail.be`, `x-api-key`, shared budget 40 requests/min | seconds to minutes by priority | `compositions.arrow`, `occupancy.arrow`, `stop-status.arrow`, fresher delays, journey messages | needs a key and a scheduler |
| HTML liveboard | `belgianrail.be/jp/nmbs-realtime/stboard.exe/nn` (scraped by the iRail API) | on demand | platform and status fallback | check whether still needed |
| iRail/stations | GitHub, pinned (CC0) | per release | `stations.arrow`, enrichment | **done** |

RIV endpoints: `dacs` (liveboards with platform and delay), `journey` (occupancy and messages), `journey/detail` (per-stop real-time state), commercial train compositions. They cannot refresh the whole network at 40 requests/min, so a prioritising scheduler is part of that work.

## GTFS-RT feed (sampled)

* About 108 KB per snapshot (25 KB gzipped); a full dataset (`incrementality` 0) with a header timestamp that advances every 30 s; GTFS-RT version 1.0.
* 377 trip updates in the first sample: 372 scheduled, 5 `CANCELED` trips and 162 `SKIPPED` stop updates. Only TripUpdates: no vehicle positions and no alerts.
* Every stop-time update has arrival/departure delay and absolute time. The `stop_id` is platform-level (`8866001_3`): the part after `_` is the platform, which maps to the platform IRI `<station IRI>#3` ([platforms.arrow](arrow-schemas.md#platformsarrow)). It exists only for stops with live updates.
* `trip_id` equals the static GTFS `trip_id` (`88____:007::8200510:8814001:14:1442:20261108`), so the LC `tripTemplate` `https://irail.be/id/be.sncb/trips/{trip_id}` reproduces our trip IRIs. A `stopTemplate` does not (platform ids against station-level core stops); stop updates resolve through the iRail adapter instead.

## Published GTFS-RT objects

| URL | Content | Caching |
| --- | --- | --- |
| `https://cdn.routableconnections.com/realtime/sncb/gtfs-rt/trip-updates.pb` | upstream protobuf, byte for byte, **latest version only** | `max-age=15` |

That is the only object: the feed timestamp is in the protobuf header, there is no companion file, and no archive is kept (history is a separate concern). The operator is part of the path so that other operators and feeds can sit next to it (`/realtime/<operator>/<format>/…`). Attribution: NMBS/SNCB real-time data via Belgian Mobility, CC BY 4.0; it is recorded in the `gtfs-rt` source of the release's `irail.json` once the feed is linked.

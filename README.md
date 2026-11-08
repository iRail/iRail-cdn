# iRail CDN

The NMBS/SNCB timetable as **[Linked Connections 2.0-alpha](https://linkedconnections.org/specification/2-0-alpha)**, built in GitHub Actions with the pinned [gtfs2lc](https://github.com/linkedconnections/gtfs2lc) `feat-arrow` converter and published on GitHub Pages. The five core Arrow tables follow LC exactly; iRail adds a separately versioned extension profile (`1-alpha`) with raw aliases, an integrity catalog and static enrichment. There is no calls dataset: consumers reconstruct stop visits from connections.

Scope of this repository today is the planned (static) timetable, [phase 1 of PLAN.md](PLAN.md#delivery-order). The contracts in [specs/](specs/README.md) also describe phase-2 live data (real-time, occupancy, compositions, LDES feed); the Cloudflare code for that is not part of this repository yet.

## Planned data on GitHub Pages

The workflow [publish-planned.yml](.github/workflows/publish-planned.yml) runs daily (07:25 UTC), on manual dispatch and when the pipeline changes. It never needs Cloudflare or RIV credentials.

| Step | Script | Result |
| --- | --- | --- |
| Check | `npm run check:planned` | Contracts, fixture conversion with the pinned converter, validation, assembly/retention, independent reader. Also runs in [ci.yml](.github/workflows/ci.yml) for every push and pull request. |
| Restore | [restore-pages.mjs](scripts/restore-pages.mjs) | Re-downloads the retained releases of the live site and verifies them against `releases/index.json` and each release's integrity catalog. A fresh Pages deployment only contains what the new artifact contains. |
| Stations | [lib/stations.mjs](scripts/lib/stations.mjs) | Verifies the pinned iRail/stations checkout and strictly parses `stations.csv`; a malformed row fails the build. |
| Convert | [build-sncb.mjs](scripts/build-sncb.mjs), [convert-gtfs.mjs](scripts/convert-gtfs.mjs) | Downloads the archive, extracts a disposable copy, runs gtfs2lc at the commit pinned in [config/converter.json](config/converter.json) with the shared [identity policy](config/sources.json), then adds `stop/trip/route-enrichment.arrow`, `identity-strategy.json` and `irail.json` (integrity catalog) without touching core Arrow bytes. |
| Validate | [validate-release.mjs](scripts/validate-release.mjs) | Pinned LC schemas, metadata, foreign keys, page bounds/regions, hashes/counts/media types, extension joins. |
| Assemble | [assemble-pages.mjs](scripts/assemble-pages.mjs) | New release + retained releases + latest `manifest.jsonld` + `releases/index.json` + `index.html` + `.nojekyll`; size budget and retention from [config/sncb.json](config/sncb.json). Writes the destination only when everything validates. |
| Deploy / verify | `configure-pages`, `upload-pages-artifact`, `deploy-pages`, [check-pages.mjs](scripts/check-pages.mjs) | Serialized (`concurrency: pages`), deployment-scoped `pages: write` / `id-token: write`, then an informational native HTTP report. A verified, immutable rollback artifact is kept for 30 days. |

One-time setup: *Settings → Pages → Source: GitHub Actions*. The public base path comes from `actions/configure-pages` (`/iRail-cdn` for the project site, empty for a custom domain) and is passed as `--prefix`; it changes links, never entity IRIs. The GTFS URL defaults to [config/sncb.json](config/sncb.json) and can be overridden with the repository variable `SNCB_GTFS_URL` or the dispatch input.

Published layout (the same under any prefix):

```
manifest.jsonld                         latest discovery (short caching)
index.html, .nojekyll, releases/index.json
releases/<releaseId>/manifest.jsonld    immutable copy; also stops/trips/routes/transfers.arrow,
                                        connections/<region>/<bucket>/NNNNN.arrow, *-enrichment.arrow,
                                        irail.json (catalog, capabilities, provenance), identity-strategy.json
```

Run the whole pipeline locally (Node 24, a checkout of gtfs2lc at the pinned commit, no credentials):

```sh
git clone https://github.com/linkedconnections/gtfs2lc ../gtfs2lc && git -C ../gtfs2lc checkout "$(jq -r .commit config/converter.json)" && (cd ../gtfs2lc && npm ci)
npm ci
npm run build:sncb -- --prefix /iRail-cdn --days-back 0 --days-forward 3     # downloads the SNCB GTFS; or --archive file.zip
npm run assemble:pages -- --prefix /iRail-cdn
npm run serve:planned -- --prefix /iRail-cdn                                  # http://127.0.0.1:8080/iRail-cdn/manifest.jsonld
```

Use `GTFS2LC_DIR` or `--converter` for another checkout; an unpinned or modified checkout is refused unless `--allow-unpinned` is given (development only). The local server proves the layout and the reader, **not** GitHub Pages' header behavior.

**Base URIs.** One identifier per concept: a station is `http://irail.be/stations/NMBS/00<hafas>` (the iRail identifier; it is also the core stop that connections use), a platform is `<station IRI>#<platform>` (extension `platforms.arrow`, dereferences to the station), a vehicle is `http://irail.be/vehicle/<label><number>`. Trips, routes, runs and connections live under `https://irail.be/id/be.sncb/`. The GTFS parent-station and platform rows are removed before conversion, so the core has one stop per station. The API's legacy connection IRI (`http://irail.be/connections/<hafas>/<date>/<vehicle>`) is deliberately not used: the SNCB feed has several scheduled trips with the same vehicle number on one day (for example IC 5130), so it is not unique. See [identifiers](specs/identifiers.md).

**Measured on 8 November 2026** (real feed `2026-11-07`, horizon 6 Nov 2026 – 9 Jan 2027, pinned converter, local machine): 2,718,314 connections in 262 pages (regions: 1), 437 MiB per release, 209 s, about 4.6 GiB peak converter memory. Two releases (~915 MB) are the most that fit the 1 GB Pages ceiling, hence `retention.maxReleases: 2` and a 950 MB budget; an overflow fails the build and keeps the last good deployment. A GitHub-hosted runner must be re-measured.

**Stations.** [iRail/stations](https://github.com/iRail/stations) (CC0), pinned in [config/stations.json](config/stations.json) and checked out by the workflow, supplies the curated station list. It is published as `stations.arrow` (743 stations incl. those outside the feed: neutral name plus French/Dutch/German/English alternatives, TAF/TAP and telegraph codes, country, coordinates, average stops, official transfer time) and fills the same fields in `stop-enrichment.arrow` for every stop and platform of a curated station. A null alternative means the neutral name applies. Locally pass `--stations ../irail-stations` (or `STATIONS_DIR`); without it the dataset is declared `unavailable` and the timetable is still built. Feed stops that the curated list lacks (12 on 8 Nov 2026, mostly foreign stations such as Frankfurt Süd and Nürnberg) are added with `source: gtfs`: feed name and translations, country from the UIC prefix, coordinates, and average runs per day computed from the release's connections; codes and the official transfer time stay null. Platform names, facilities and boarding statistics of that repository are not imported yet.

**Headsigns.** The core `trips.headsign` is the feed's French text. The GTFS also translates headsigns to Dutch, German and English; `headsigns.arrow` publishes them as a lookup keyed by the French headsign (242 distinct values on 8 Nov 2026, 241 with Dutch and 239 with German/English; German/English values are bilingual as in the source).

**Not yet available** (declared `unavailable` in `irail.json`, not published as empty tables): shapes (the feed has no `shapes.txt`), `connectionEnrichment`, `transferEnrichment`, platform overrides from `stop_time_overrides.txt`, a licence IRI (rights text only), and every live overlay. Native Pages conformance (media types, CORS, caching) and an independent browser reading the deployed site are production acceptance steps that need a first deployment.

## Check

Node 24 and a checkout of gtfs2lc at the pinned commit (see the local run above) are all that is needed; no credentials, Worker or Cloudflare tooling.

```sh
GTFS2LC_DIR=../gtfs2lc npm run check:planned
```

This generates the synthetic contract fixtures and runs the contract tests, the SNCB identity tests and the offline end-to-end tests (fixture GTFS → converter → validation → Pages assembly/retention → static server → independent reader). Without a converter checkout the end-to-end tests are skipped; CI sets `REQUIRE_CONVERTER=1`.

# Cloudflare setup for the GTFS-RT publisher

The cron-only Worker [src/gtfs-rt/](../src/gtfs-rt/) republishes the open NMBS/SNCB GTFS-RT TripUpdates feed every 30 seconds, **latest snapshot only** (archiving is a separate concern). Clients read it directly from R2 through `cdn.routableconnections.com`, so no download passes through a Worker.

```
hafas open feed ──(2 fetches/min, cron)──▶ Worker ──▶ R2 bucket ──▶ cdn.routableconnections.com (edge cache)
                                                        realtime/gtfs-rt/trip-updates.pb   (max-age 15 s)
                                                        realtime/gtfs-rt/latest.json       (max-age 15 s)
```

The upstream feed needs **no credential**. Nothing below has to be sent to anyone but Cloudflare and GitHub; never paste tokens into issues, chats or commits.

## One-time setup in Cloudflare (dashboard)

1. **R2 → Create bucket** named `irail-cdn-data` (or change `bucket_name` in [wrangler.worker.jsonc](../wrangler.worker.jsonc)). Choose a European location hint. R2 may ask for a payment method at activation; usage within the free quota is not charged.
2. **Bucket → Settings → Custom Domains → Connect domain** `cdn.routableconnections.com` (the zone must be in the same Cloudflare account; the DNS record and certificate are created for you). Leave the `r2.dev` public URL **disabled**.
3. **Bucket → Settings → CORS policy**, so browsers can read the feed:
   ```json
   [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag", "Content-Length"], "MaxAgeSeconds": 3600 }]
   ```
4. **Caching → Cache Rules → Create rule**: *When* hostname equals `cdn.routableconnections.com` and URI path starts with `/realtime/`; *Then* cache eligibility **Eligible for cache**, Edge TTL **Use cache-control header if present, bypass cache if not**, Browser TTL **Respect origin**. Without a rule Cloudflare does not cache `.pb` files, and every poll would read R2. The objects carry `Cache-Control: public, max-age=15`.

## One-time setup in GitHub

1. **Cloudflare → My Profile → API Tokens → Create Custom Token** with *Account · Workers Scripts · Edit* and *Account · Workers R2 Storage · Edit*, limited to your account. No zone permissions are needed.
2. **GitHub → repository → Settings → Environments → New environment `cloudflare`**, then add
   * secret `CLOUDFLARE_API_TOKEN` — the token above;
   * variable `CLOUDFLARE_ACCOUNT_ID` — your account ID (Cloudflare dashboard → Workers & Pages → right-hand sidebar). It is not secret.
3. Run **Actions → Deploy GTFS-RT publisher → Run workflow** (it also runs on pushes to `src/gtfs-rt/**`). The job summary of its last step shows the live check.

## Verify

```sh
npm run check:realtime:live     # or: node scripts/check-realtime.mjs https://cdn.routableconnections.com
curl -sI https://cdn.routableconnections.com/realtime/gtfs-rt/trip-updates.pb   # cf-cache-status, content-type, cache-control
curl -s  https://cdn.routableconnections.com/realtime/gtfs-rt/latest.json
```

Wait about a minute after the first deploy. The Cloudflare dashboard (Workers → `irail-gtfs-rt` → Logs) shows one `{"event":"gtfs-rt",…}` line per poll: `published`, `unchanged` (the upstream had not refreshed yet) or an error.

When the check passes, set `realtime.enabled` to `true` in [config/sncb.json](../config/sncb.json). The next timetable build then links the feed from `manifest.jsonld` (`realtime[]` with a `tripTemplate`, verified by the converter against every trip IRI). Do not enable it earlier: a manifest must not advertise a feed that is not being served.

## Free-tier budget

| Resource | Use | Free limit |
| --- | --- | --- |
| Worker invocations | 1,440/day (one cron per minute) | 100,000/day |
| Upstream fetches | 2,880/day, 2 per invocation | 50 subrequests per invocation |
| Worker CPU | about 1 ms per poll (header-only parse, no protobuf decode) | 10 ms per invocation |
| R2 writes | up to 5,760/day (2 objects per new snapshot) ≈ 173,000/month | 1,000,000/month |
| R2 storage | 2 small objects (~110 KB) | 10 GB |
| Reads and egress | served from the edge cache; R2 egress is free | — |

These limits are from Cloudflare's documentation at the time of writing: check the current figures in the dashboard. Two things to watch on the first days: that every cron run really performs its second poll after about 30 s (a Worker may not be kept alive that long on the free plan; if it is not, switch the loop to a Durable Object alarm), and that `cf-cache-status` becomes `HIT`, which keeps R2 reads far below the 10 million/month limit.

## Operating notes

* **Stop or pause:** set `GTFS_RT_URL` to `""` in `wrangler.worker.jsonc` and redeploy, or delete the Worker. The last objects stay in the bucket.
* **Different upstream or a token-protected mirror:** change `GTFS_RT_URL`; for a credential run `npx wrangler secret put GTFS_RT_TOKEN --config wrangler.worker.jsonc` (and set `GTFS_RT_TOKEN_HEADER` if the header is not `x-rt-token`). Redirects are never followed, so the credential cannot be replayed to another host.
* **What is validated before publishing:** HTTPS, HTTP 200, complete download (length and protobuf framing), GTFS-RT version, full-dataset incrementality, a timestamp that is not in the future and not older than the published one. A failure leaves the previous snapshot in place.
* **Local test:** `npm run check:realtime` (no Cloudflare needed). To run the Worker locally against a local R2 emulation use `npx wrangler dev --test-scheduled --config wrangler.worker.jsonc` and trigger it with `curl 'http://localhost:8787/cdn-cgi/handler/scheduled'`; put a credential for a protected mirror in an untracked `.dev.vars`.
* **Provenance:** NMBS/SNCB real-time data via Belgian Mobility, CC BY 4.0. `latest.json` carries the attribution and licence.

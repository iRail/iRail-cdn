export interface Env {
  /** R2 bucket served publicly on the custom domain. */
  DATA: R2Bucket;
  /** Upstream GTFS-RT TripUpdates feed (HTTPS). Empty disables collection. */
  GTFS_RT_URL?: string;
  /** Optional credential for token-protected mirrors; the open hafas feed needs none. */
  GTFS_RT_TOKEN?: string;
  GTFS_RT_TOKEN_HEADER?: string;
}

# Tower Map

> **Applies to:** RM520N-EU / RM520N-GL · built and tested off-device (BusyBox 1.36 + headless Chromium), not yet on hardware

`/cellular/tower-map` shows the serving tower, the user's position, the timing-advance ring and nearby towers of the SIM's operator, plus true and magnetic azimuth for antenna aiming.

| Item | Value |
|------|-------|
| Page | `app/cellular/tower-map/page.tsx`, `components/cellular/tower-map/{tower-map,map-view}.tsx` |
| Hook | `hooks/use-tower-map.ts` |
| Geodesy | `lib/tower-geo.ts` (haversine, bearing, `LTE_TA_STEP_M = 78.125`, `LT_DECLINATION_DEG = 8`) |
| CGI | `cellular/tower_map.sh` — GET state, GET `?towers=<mcc>`, POST `update_db`, `save_home`, `clear_home`, `set_override`, `clear_override` |
| Config | `/etc/qmanager/tower_map.json` — `home {lat,lon}`, `overrides {"<mcc>-<mnc>-<enb>": {lat,lon}}` (cap 500) |
| Index | `/etc/qmanager/towers/<mcc>.json` — `{mcc, generated, built, towers:[{r,m,e,la,lo,c,s,u,g}]}` |
| Source | With the user's key: OpenCelliD's own daily per-MCC export, `…/ocid/downloads?token=<key>&type=mcc&file=<mcc>.csv.gz` on opencellid.org, then download.unwiredlabs.com. Without: the mirror `github.com/NorthveilSystems/treadstone-celldata` releases (`manifest.json` + `<mcc>.csv.gz`). CC BY-SA 4.0 |
| Key | `/etc/qmanager/opencellid_token` (mode 600, not in backups); POST `save_token` / `clear_token`, GET reports only `has_token` |

- **One row per eNB/gNB.** `build_index` merges sectors (LTE `eNB = ECI / 256`, NR `gNB = NCI / 16384`, matching the poller's `enodeb_id`) into a samples-weighted centroid. Cell positions in OpenCelliD are where phones measured, so the centroid of all sectors sits nearer the mast than any one sector.
- **Integrity.** The mirror's CSV is checked against the manifest's sha256 before the index is replaced; a mismatch keeps the old index. OpenCelliD publishes no checksum, so its download must be a valid gzip (`gzip -t`) and build at least one tower.
- **OpenCelliD key.** The key reaches curl on stdin (`-K -`), never its command line. Errors come back as a short text body: `rate_limited` (two downloads per file per day), `invalid_token`, else `download_failed`, which tries the second host. The index records `source`. The page refreshes a key-sourced database older than 7 days once per visit, without a toast; no timer does it.
- **Operator.** The MCC/MNC comes from the SIM IMSI (`simPlmnFromImsi`), not the serving PLMN.
- **Corrections win.** A user correction replaces the database position everywhere (map, distance, Cell Guard).
- **Leaflet** loads inside an effect (`next/dynamic`, `ssr:false`); the map redraws only when its inputs change, and refits only when home or the tower first appears. Tiles: OpenStreetMap and Esri World Imagery, loaded by the browser.
- **Scanned towers.** GET also returns `scan` — the last Cell Scanner sweep (`/tmp/qmanager_cell_scan_result.json`, copied to `/etc/qmanager/towers/last_scan.json` so it survives a reboot). The page groups cells per eNB/gNB (same divisors as the index), locates them through the index and corrections, and draws an aim line with distance and true/compass bearing. Only `[0-9][0-9][0-9].json` files count as databases.
- **Location** is set by tapping the map: QManager is served over `http://`, where browsers refuse geolocation.
- **BusyBox awk** on the build host has no math functions; the index builder uses only arithmetic, and Cell Guard's distance check uses `jq`.

# Performance: web UI compression, poller idle mode, flash writes, Resources page

> **Applies to:** RM520N-EU / RM520N-GL · tested off-device (lighttpd 1.4.74 locally, BusyBox 1.31.1), not yet on hardware

| Item | Value |
|------|-------|
| Compression | `scripts/usrdata/qmanager/lighttpd-speed.conf` → `/usrdata/qmanager/lighttpd-speed.conf`, pulled in by `include_shell` at the end of `lighttpd.conf`; cache `/usrdata/qmanager/deflate-cache` |
| Installer | `install_speed_conf`: needs `/opt/lib/lighttpd/mod_deflate.so` (Entware `lighttpd-mod-deflate`), copies the file, keeps it only if `lighttpd -tt` passes; clears the cache every install |
| Poller idle | `POLL_INTERVAL_IDLE=8` s after `UI_IDLE_AFTER=120` s without a request; flag `/tmp/qmanager_ui_active` touched by `cgi_base.sh` after `require_auth` |
| Data Used | every tick → `/tmp/qmanager_data_used.json` (printf, no jq); copied to `/usrdata/qmanager/data_used.json` every 300 s, on reset/baseline/migration and on TERM |
| Resources | `monitoring/resources.sh` (GET, one cat + one awk + one df), `/monitoring/resources`, `hooks/use-resources.ts`; CPU delta snapshot `/tmp/qmanager_resources_prev` |

- **Only static files are compressed** (`$HTTP["url"] !~ "^/(cgi-bin|console)"`): CGI replies are small and polled every 2 s. Each file is compressed once and cached; `deflate.max-loadavg 2.50` skips compression when busy. A 400 KB chunk ships as ~107 KB.
- `/_next/static/` gets `Cache-Control: public, max-age=31536000, immutable` (file names carry a content hash). `mod_setenv` is built into lighttpd since 1.4.59, so only `mod_deflate` is a file to check.
- **Idle mode** slows every cycle-counted tier by 3–4×: Tier 2 (temperature, carrier) ~every 3 min, ping history rows ~every 50 s instead of ~16 s. Opening any page restores full speed within one cycle. Checks timed by uptime (Cell Guard SMS, signal history minutes, watch checks) are unaffected.
- **Data Used** loses at most 5 minutes of counting on a power cut; a poller restart within the same boot loads the RAM copy when it is newer. The health check reads the RAM copy's age.
- `data_used.sh` answers with one jq instead of three. Cell Guard no longer rewrites its known-cell file when a known cell's line is unchanged.
- **Resources:** CPU % is the jiffies delta between two GETs; kernel threads (no RSS) are listed only while they use ≥ 1 % CPU. `df` of `/usrdata` and `/etc` is deduplicated by mount point.
- **Poller hot path forks nothing.** Code that runs every poll cycle (Cell Guard jamming check) reads `/proc/uptime` with the `read` builtin and sets variables through `eval`, never `$(...)`; measured with `strace -f`: 0 forks per 100 checks in bash and dash.

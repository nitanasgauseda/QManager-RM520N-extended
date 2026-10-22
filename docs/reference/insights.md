# Insights: Signal History, Data Plan, Temperature

> **Applies to:** RM520N-EU / RM520N-GL · tested off-device on BusyBox 1.31.1 (59 checks), not yet on hardware

The poller sources `usr/lib/qmanager/insights.sh` and calls `insights_check` every cycle, after `cell_guard_check`. It records long-term history, counts data-plan usage and raises temperature alerts.

| Item | Value |
|------|-------|
| Library | `scripts/usr/lib/qmanager/insights.sh` (bash: byte counters need 64-bit arithmetic) |
| CGIs | `monitoring/insights.sh` (GET config + status, POST `save`), `monitoring/signal_history.sh` (GET `?range=24h\|7d\|30d`) |
| Pages | `/monitoring/signal-history` (charts + band advisor), `/monitoring/usage` (data plan, temperature, history settings) |
| Hooks | `hooks/use-insights.ts` (`useInsights`, `useLongHistory`) |
| Config | `/etc/qmanager/insights.json` — `history {enabled, days 1-90}`, `data_limit {enabled, limit_gb, billing_day 1-28, warn_pct 50-99, used_mb, set_at}`, `temperature {enabled, alert_c 50-100}` |
| State | `/etc/qmanager/insights_state.json` — `cycle_start, cycle_base, warned, set_at, temp_high` (written only on change) |
| Status | `/tmp/qmanager_insights.json` |
| History | RAM buffer `/tmp/qmanager_sighist_buf.csv`, flushed every 15 lines to `/usrdata/qmanager/sighist/d<utc-day>.csv` |
| Reload flag | `/tmp/qmanager_insights_reload` |
| Events | `data_limit`, `temperature_high`, `temperature_normal`; alert events `data_limit`, `temperature` (routed to every enabled channel by default) |

## History

- One CSV line per minute, timed by `/proc/uptime`: `ts,net,lband,lpci,lenb,lrsrp,lrsrq,lsinr,nband,npci,nrsrp,nsinr,temp,rx,tx`. Signal values are minute averages; `rx`/`tx` are byte deltas of the persistent Data Used counters.
- Nothing is written while the clock is before 2023-11-14 (the 1970 boot window).
- The flush skips writing when `/usrdata` has under 20 MB free, and deletes day files older than `history.days`. The poller flushes on TERM/INT so a restart loses nothing. About 100 KB per day.
- The CGI buckets by 600 s / 3600 s / 14400 s and returns per-cell totals for the advisor: a cell is keyed `net|lband|pci|enb|nband`; the advisor ignores cells with under 30 minutes and suggests a lock only for a 3 dB average SINR gain over the most recent cell.
- **BusyBox 1.31 awk:** never put a variable directly before `(` — it is parsed as a function call.

## Data plan

- Usage = `du_accumulated_rx + du_accumulated_tx` minus `cycle_base`. A cycle starts at local midnight on the billing day (`date -d`); a new cycle re-bases and logs "New billing cycle started".
- "Used so far" (`used_gb` in the POST, stored as `used_mb` + `set_at`) re-anchors the base once; a changed `set_at` is the trigger.
- A Data Used reset (counter goes down) keeps the cycle's usage continuous in a running poller.
- One alert at `warn_pct` and one at 100 % per cycle (`warned` remembers which).

## Temperature

- Two consecutive readings at or above `alert_c` raise `temperature_high` and an alert; it clears at `alert_c - 5` with `temperature_normal`.

## Backup

See [settings-backup.md](settings-backup.md); `insights.json` is in the backup, the state file is not.

# Cell Guard

> **Applies to:** RM520N-EU / RM520N-GL · heuristics tested off-device under BusyBox with simulated poller state; Rayhunter install tested with the real v0.13.0 release and its ARMv7 daemon under qemu, not on hardware

`/monitoring/cell-guard` warns when the serving cell behaves like a fake base station (IMSI catcher). Findings are `suspicious_cell` events in Network Events and the `suspicious_cell` alert event (all four channels capable, routed by default).

| Item | Value |
|------|-------|
| Heuristics | `/usr/lib/qmanager/cell_guard.sh`, `cell_guard_check` called by `qmanager_poller` after `detect_events` |
| CGI | `monitoring/cell_guard.sh` — GET, POST `save`, `reset_baseline`, `rayhunter_install`, `rayhunter_install_status`, `rayhunter_enable`, `rayhunter_disable`, `rayhunter_uninstall` |
| Config | `/etc/qmanager/cell_guard.json` — `enabled` (absent = true), `learn_hours` (0–168, default 24), `rayhunter` |
| Baseline | `/etc/qmanager/cell_guard_known` (`R|CID|TAC|PCI|ARFCN|first_seen`, cap 3000), `/etc/qmanager/cell_guard_since` |
| Status | `/tmp/qmanager_cell_guard.json` |
| Reload flag | `/tmp/qmanager_cell_guard_reload` |
| 3G/2G marker | `cg_legacy_rat`, set in `poll_serving_cell` from the raw `AT+QENG="servingcell"` reply (`parse_serving_cell` does not model WCDMA/GSM) |

## Checks (only when the serving identity changes)

| Check | Severity | Alerts |
|-------|----------|--------|
| Fallback to WCDMA/GSM | warning | yes |
| New cell, not in the tower index or corrections, after the learning window | warning | yes |
| New cell that the index knows | `new_cell` info | no |
| Known cell reports a different TAC | warning | yes |
| Known cell changed PCI or channel | info | no |
| Tower is >1.5 km from home but LTE TA ≤ 2 (≤ 156 m) | warning | yes |
| Rayhunter Medium/High warning in the live recording (polled every 30 cycles) | warning | yes |

Alerts are rate-limited to one per 10 minutes (monotonic clock); suppressed findings are counted into the next alert. Events are always written.

## Rayhunter

`/usr/bin/qmanager_rayhunter_mgr` (sudoers bare-path grant) owns every privileged step. It downloads one pinned release (`v0.13.0` linux-armv7 zip, sha256 pinned), extracts only `rayhunter-daemon` with BusyBox `unzip -p` (falls back to `-d`; installs `unzip` from Entware if missing), and checks the daemon's own pinned sha256 before installing it to `/usrdata/rayhunter/`. The worker is double-forked and reports through `/tmp/qmanager_rayhunter_install.json`.

- **Config** (`/usrdata/rayhunter/config.toml`): `device = "pinephone"` (headless display driver), `port = 8686` (8080 is the web console), recording stops below 80 MB free on `/usrdata`.
- **Exposure.** The daemon binds `0.0.0.0` with no auth. `firewall-on` adds `INPUT ! -i lo --dport 8686 DROP` (iptables and ip6tables) in `ExecStartPre`, and Cell Guard re-asserts it every poll of Rayhunter, since QCMAP can flush rules.
- **Service** `qmanager-rayhunter.service` is in `UCI_GATED_SERVICES`, gated on `cell_guard.json .rayhunter`, and `ConditionPathExists` on the daemon. Log: `/tmp/qmanager_rayhunter.log` (capped at 1 MB by Cell Guard).
- **Requirement.** Rayhunter reads `/dev/diag`. Whether the RM520N's internal Linux exposes it is not verified; the page shows "Diagnostic interface: Not found" when it is absent, and the daemon then retries and exits.
- **Uninstall** keeps recordings unless `--purge`.

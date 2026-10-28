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

## SMS checks

- `_cg_check_sms` runs every 300 s while Cell Guard is on and `cell_guard.json .sms_guard` is not `false`: one compound `AT+CMGF=0;+CMGL=4`, parsed by `_cg_sms_classify` (BusyBox awk PDU reader).
- Reported: TP-PID 0x40 (type 0, "silent"), 0x41–0x47 (replace), 0x7F (SIM data download), class 0 (flash), empty messages, WAP push that is not an MMS notification (content type ≠ 0xBE), and binary SMS to other application ports. Normal SMS and MMS notifications are not.
- Each PDU is reported once (`/etc/qmanager/cell_guard_sms_seen`, md5 prefix, last 200 kept) as event `suspicious_sms`; warnings (type 0, SIM download, config push) alert through the `suspicious_cell` routing at most once per 10 minutes.
- Limit: a modem may discard a type 0 SMS without storing it; then nothing is visible to QManager.

## Jamming

- `_cg_check_jam` runs every 10 s while Cell Guard is on and `cell_guard.json .jam_guard` is not `false`, separately for LTE (`L`, key eNB/cell) and 5G NR (`N`, key PCI), from the poller's `lte_sinr/lte_rsrp/lte_rssi` and `nr_sinr/nr_rsrp`.
- Baseline: the first 30 samples on a serving cell (5 min) seed a running average (×10 integers); after that it follows slowly (1/32 per sample) only while no anomaly is in progress. A new serving cell starts a new baseline.
- Warning (`suspicious_cell`, alert routing as other Cell Guard findings): 18 samples in a row (3 min) with SINR ≥ 10 dB below the baseline while RSRP is at most 4 dB weaker. The message adds the RSSI rise when it is ≥ 3 dB. One warning per episode.
- Recovery: SINR back within 5 dB of the baseline for 6 samples gives an `info` finding "back to normal".
- State is in memory only; a poller restart relearns for 5 minutes. A real signal drop (RSRP falls with SINR) is not reported.

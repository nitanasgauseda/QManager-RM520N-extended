# Security Check & Activity Log

> **Applies to:** RM520N-EU / RM520N-GL · tested off-device on BusyBox 1.31.1 (fixture iptables/netstat/ip output), not yet on hardware

## Security Check — `/system-settings/security`

| Item | Value |
|------|-------|
| CGI | `system/security.sh` — GET runs the checks (on demand only), POST `block_port` / `unblock_port {proto, port}` |
| Evaluator | `scripts/usr/lib/qmanager/fw_eval.awk` — walks `iptables -S` / `ip6tables -S` for a NEW packet on the cellular interface |
| Port closes | `/etc/qmanager/wan_block.conf` (`tcp 22` per line, ≤32) → chain `QMANAGER_WAN` (`-i rmnet+ … -j DROP`, IPv4 and IPv6) built by `qmanager_firewall` |

- Sockets come from `netstat -ltun`: only `0.0.0.0`, `::` or the cellular address count; DHCP (67/68/546/547) is skipped. A `::` socket is checked for both families.
- The evaluator models `-i`, `-p`, `--dport(s)`, `-s/-d` (any-address only), `--state/--ctstate` (NEW), user chains, RETURN and policies; anything else marks the result `uncertain` and does not count as a match.
- IPv4 inside carrier NAT (10/8, 100.64/10, 172.16/12, 192.168/16) is "open inside the carrier network" (warning), a public address is "open to the internet" (fail).
- `qmanager_firewall` now also guards 80/443 with `ip6tables` (same trusted interfaces): before, a `[::]` web server was reachable over the carrier's public IPv6.
- ADB state is field 9 of `AT+QCFG="usbcfg"`; the page shows the same command with that field set to 0 but never sends it.

## Activity Log — `/system-settings/activity-log`

| Item | Value |
|------|-------|
| Writer | `qm_audit` / `qm_audit_post` in `cgi_base.sh` (every `cgi_read_post`), plus `login.sh`, `logout.sh`, `backup.sh` |
| Log | `/etc/qmanager/audit.log` NDJSON `{t, kind: login|logout|change, what, detail, ip}`, trimmed to 500 |
| Dedupe | `/tmp/qmanager_audit_recent` — same change (or sign-in lockout) from the same address within 300 s is written once |
| CGI | `system/audit.sh` — GET newest first, POST `clear` |

- `detail` is only `.action` or `.command` (AT terminal), filtered to safe characters, ≤60 chars; request bodies, passwords and tokens are never logged. Read-like actions (`get*`, `list*`, `status`, …) are skipped.
- Sign-in alerts: `login.sh` appends `login<TAB>message` to `/tmp/qmanager_alert_queue` on success and on lockout; the poller's `_in_drain_queue` (insights.sh) sends it through alert event `login` (routing default off on every channel).

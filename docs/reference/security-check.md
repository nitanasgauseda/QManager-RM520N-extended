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


## Cellular-side privacy (stealth, LAN IPv6 off)

| Item | Value |
|------|-------|
| Flags | `/etc/qmanager/wan_stealth`, `/etc/qmanager/lan_ipv6_off` (presence = on) |
| CGI | `system/security.sh` POST `set_privacy {stealth, lan_ipv6}`; GET `privacy {stealth, lan_ipv6, stealth_active, lan_ipv6_off_active}` |
| Rules | `qmanager_firewall` `stealth_start` / `lan6_start`; `ensure` checks every hook this script owns (web UI `QMANAGER_FW` on IPv4 and IPv6, `QMANAGER_WAN` while `wan_block.conf` has lines, stealth, LAN IPv6, both on and off) and rebuilds the whole set with `do_start` on any mismatch (`watch.sh` `_wt_check_fw`, every 120 s, always) |

- Stealth (IPv4 and IPv6, `rmnet+` only): INPUT `QMANAGER_STEALTH` drops echo-request; OUTPUT `QMANAGER_STEALTH_OUT` drops port/protocol-unreachable and TCP RST in the conntrack REPLY direction only (`-m conntrack --ctdir REPLY`, i.e. answers to connection attempts from outside); resets on connections the modem opened itself (Traffic Engine `tpws`, Tailscale, curl) still go out. A kernel without `--ctdir` gets the old drop-every-RST rule. NDP, RA and packet-too-big are never touched; FORWARD is never touched, so IPPT traffic and the router's own firewall decide for the router.
- LAN IPv6 off: ip6tables FORWARD `QMANAGER_LAN6` rejects `-i bridge0` (icmp6-adm-prohibited, DROP fallback) and drops `-o bridge0`; OUTPUT `QMANAGER_LAN6_OUT` drops RA and DHCPv6 replies (sport 547) on `bridge0`. The modem keeps its own IPv6.
- `lan_ipv6` in the API means "IPv6 on for the LAN"; the flag file records it off.

## Activity Log — `/system-settings/activity-log`

| Item | Value |
|------|-------|
| Writer | `qm_audit` / `qm_audit_post` in `cgi_base.sh` (every `cgi_read_post`), plus `login.sh`, `logout.sh`, `backup.sh` |
| Log | `/etc/qmanager/audit.log` NDJSON `{t, kind: login|logout|change, what, detail, ip}`, trimmed to 500 |
| Dedupe | `/tmp/qmanager_audit_recent` — same change (or sign-in lockout) from the same address within 300 s is written once |
| CGI | `system/audit.sh` — GET newest first, POST `clear` |

- `detail` is only `.action` or `.command` (AT terminal), filtered to safe characters, ≤60 chars; request bodies, passwords and tokens are never logged. Read-like actions (`get*`, `list*`, `status`, …) are skipped.
- Sign-in alerts: `login.sh` appends `login<TAB>ok|locked<TAB>REMOTE_ADDR` to `/tmp/qmanager_alert_queue` on success and on lockout; the poller's `_in_drain_queue` (insights.sh) writes the sentence itself (fixed text, address limited to `[0-9A-Fa-f.:]`, ≤ 45 chars), so a line planted in the world-writable queue cannot add words of its own, and sends it through alert event `login` (routing default off on every channel).

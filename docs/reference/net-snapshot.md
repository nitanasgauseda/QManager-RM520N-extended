# Network snapshots (Security page)

> **Applies to:** RM520N-GL (EU edition) · not yet run on hardware

| Item | Value |
| --- | --- |
| Cards | **System Settings → Security**: "Blocked from the internet", "Who is talking to whom" (`components/system-settings/security/net-snapshot.tsx`, `hooks/use-net-snapshot.ts`) |
| CGI | `system/net_snapshot.sh` — `GET ?kind=fw` / `?kind=ct` → `{success, kind, age, data}` |
| Producer | `_wt_check_snap` in `watch.sh` (poller, root), once per cycle: a `[ -e ]` test, nothing else unless asked |
| Request flags | `/tmp/qmanager_netsnap_fw`, `/tmp/qmanager_netsnap_ct` (www-data creates, root deletes) |
| Snapshots | `/tmp/qmanager_fw_blocked.json`, `/tmp/qmanager_conntrack.json` (root, `qm_replace`, 0644) |

## Why a round trip

iptables counters and `/proc/net/nf_conntrack` need root; the CGI runs as www-data. The CGI asks only when the last snapshot is older than 5 s; the poller answers on its next cycle, at most once per 3 s per kind. The hook re-asks every 1.5 s, up to 12 times, until `age ≤ 5`. Nothing runs while nobody has the page open.

## Blocked (`kind=fw`)

- One `iptables -L -n -v -x` and one `ip6tables` call, summed by awk. Counted: `DROP`/`REJECT` rules in `QMANAGER_FW` and `QMANAGER_WAN` (kind `port`, per proto/port), `QMANAGER_STEALTH` (`ping`), `QMANAGER_FWD6` (`lan6`, unrequested IPv6 to LAN devices). `QMANAGER_STEALTH_OUT` and `QMANAGER_LAN6` are outbound and not counted.
- Counters reset whenever `qmanager_firewall` rebuilds its chains (a QCMAP re-dial triggers `ensure`), so the card says "since the firewall rules were last applied". No new rules, no LOG targets.
- ip6tables prints an empty `opt` column, so the parser uses only fields 1–4 positionally and finds `dpt:` by regex.

## Connections (`kind=ct`)

- Grouped by the original source address; per source the 15 busiest destination/port/proto entries, at most 30 sources. Loopback is skipped.
- Bytes are shown only when `/proc/sys/net/netfilter/nf_conntrack_acct` is 1 (`bytes_counted`).
- In IP Passthrough the router's NAT hides individual devices: every flow appears under the router's address.
- Names come from `network/lan_devices.sh` (DHCP leases + neighbours), matched by IP in the browser.

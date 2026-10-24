# Watch checks: SIM change, roaming, public IP, outages, monthly report

> **Applies to:** RM520N-EU / RM520N-GL · tested off-device on BusyBox 1.31.1 and bash (28 checks), not yet on hardware

The poller sources `usr/lib/qmanager/watch.sh` and calls `watch_check` every cycle, after `dns_privacy_watch`.

| Item | Value |
|------|-------|
| Library | `scripts/usr/lib/qmanager/watch.sh` |
| CGIs | `monitoring/watch.sh` (GET config + roaming state + public IP, POST `save` / `check_ip`), `monitoring/outages.sh` (GET `?days=7\|30\|90`) |
| Pages | Roaming card on `/monitoring/usage`, Public IP card on `/system-settings/security`, `/monitoring/outages` |
| Hooks | `hooks/use-watch.ts`, `hooks/use-outages.ts` |
| Config | `/etc/qmanager/watch.json` — `roaming {alert (default true), block (default false)}`, `public_ip {enabled (default true)}`; in backups |
| Status | `/tmp/qmanager_watch.json`, `/tmp/qmanager_pubip.json` (also read by the Telegram bot) |
| Outage log | `/etc/qmanager/outages.log` — `<start> <end> <eNB> <network type>`, one line per outage, appended on restore, trimmed to 2000 lines; open outage in `/tmp/qmanager_outage_open` |
| Month state | `/etc/qmanager/watch_month.json` — `{month, rx, tx}` Data Used counters at the month's start |
| Reload flag | `/tmp/qmanager_watch_reload` (also forces the next public IP lookup) |
| Alert events | `sim_change`, `roaming` (all channels on by default), `ip_change` (off), `monthly_report` (email, Telegram, Discord) |
| Network events | `sim_change`, `roaming`, `public_ip_changed`, `monthly_report` |

- **SIM.** The poller's boot check (`/tmp/qmanager_sim_swap_detected`, an ICCID not in the known set) alerts once per boot. A runtime ICCID change (slot switch, `read_sim_identity`) and `t2_sim_inserted` going true → false alert too.
- **Roaming** is `stat 5` from `AT+CEREG?`, then `AT+C5GREG?`, then `AT+CREG?`, sent one at a time (an unsupported command fails a whole `;` chain), every 120 s. A change needs two readings in a row. MVNOs that register as roaming at home will trip it; the alert can be turned off.
- **Roaming block** is `FORWARD -j QMANAGER_ROAM` with `-o rmnet+ -j DROP`: it stops new connections from LAN devices; the modem's own traffic (IMS, SMS) is untouched. Flows already offloaded to IPA hardware may keep running. The rule is re-checked against iptables only every 120 s.
- **Public IP** is fetched in the background with `curl -s4` (api.ipify.org, then ipv4.icanhazip.com) every 30 min and whenever `t2_wan_ipv4` changes, only while the internet is up and the clock is set. CGNAT = the WAN address is private / 100.64.0.0/10, or differs from the public one.
- **Outages** follow `conn_internet_available` (the ping daemon's verdict), not the events.sh debounce. Nothing is recorded before the clock is set.
- **Monthly report** runs every 10 min; at the first check of a new month it builds the previous month from the outage log, the signal history day files (`/usrdata/qmanager/sighist/d<day>.csv`: average RSRP column 6, SINR column 8, most common eNB column 5) and the Data Used counter delta (a reset during the month counts from zero). The first run only seeds the state.
- **Uninstall** removes the `QMANAGER_ROAM` chain.

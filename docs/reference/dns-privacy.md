# DNS Privacy (encrypted DNS)

> **Applies to:** RM520N-EU / RM520N-GL · tested off-device (Go tests, the ARM binary under qemu, BusyBox 1.31.1 CGI tests), not yet on hardware

`/local-network/dns-privacy` turns on DNS over TLS for every LAN device. An iptables nat rule redirects every DNS query arriving on `bridge0` (port 53, UDP + TCP, whatever server the device asked) to a local forwarder. dnsmasq is never edited, reloaded or restarted.

> **Never restart dnsmasq on the RM520N.** `systemctl restart dnsmasq_service@0` fails in IP Passthrough mode: QCMAP's config binds `interface=bridge0` with `bind-interfaces`, the passthrough address (the carrier IP, `/32` on `bridge0`) cannot be bound, and dnsmasq exits with status 2, leaving the LAN without DNS until a reboot. SIGHUP does not re-read `server=` / `no-resolv` either, which is why the first version (a `dnsmasq.conf` block) never took effect. Install and the poller strip that v1 block without a reload.

| Item | Value |
|------|-------|
| Forwarder | `dnsguard/` (Go, standard library only) → `/usrdata/qmanager/bin/qmanager_dnsguard`, built by `build-dnsguard.sh` |
| Unit | `qmanager-dnsguard.service` (gated, `MemoryLimit=48M`, `Restart=always`) |
| Listen | `127.0.0.1:5335` and `<LAN IPv4 of bridge0>:5335`, UDP + TCP, bound per address (status `listening`); chain `QMANAGER_DNS` in `filter` drops `-i rmnet+` to 5335 |
| Redirect | `nat` chain `QMANAGER_DNS` (`-p udp/tcp --dport 53 -j DNAT --to-destination <LAN IPv4 of bridge0>:5335`), hooked `PREROUTING -i bridge0` at position 1. IPv4 only; added only once `listening` holds the LAN address |
| Failed flag | `/etc/qmanager/dnsguard_redirect_failed` — set when redirected lookups never reach the forwarder; blocks re-adding until the next save |
| Local names | single-label names, `.lan` / `.localdomain` / `.home.arpa` / `.internal` and PTR of 10/8, 172.16/12, 192.168/16, 169.254/16 go to dnsmasq on the first private IPv4 of `bridge0` (`-local-dns auto`) |
| Config | `/etc/qmanager/dnsguard.json` — `encrypt {enabled, provider, fallback, nextdns_id, custom_host, custom_ip}` |
| Status | `/tmp/qmanager_dnsguard.json` (every 5 s; `mem_kb` is VmRSS) |
| Flags | `/tmp/qmanager_dnsguard_reload`, `/tmp/qmanager_dnsguard_update` |
| CGI | `network/dns_privacy.sh` — GET, POST `save` |
| Shared lib | `scripts/usr/lib/qmanager/dns_privacy.sh` (`dp_redirect`, `dp_guard_on/off`, `dp_legacy_cleanup`, `dns_privacy_watch`) |

- **Memory first (178 MB modem).** `SetMemoryLimit(16 MB)`, GC 50, unit `MemoryLimit=24M`. No HTTP stack in the binary: DoT only. Binary ~5 MB on `/usrdata`.
- **Encrypted DNS** is DoT to fixed provider IPs (no DNS needed to find DNS), certificates checked against the embedded Mozilla bundle. Before the clock is set (`< 1700000000`) TLS cannot verify; with `fallback` on, lookups go to the carrier resolvers from `/run/resolv.conf` or `/etc/resolv.conf` (loopback/local addresses skipped), otherwise SERVFAIL.
- **Ad blocking was removed** (user decision, 2026-10-23): with HaGeZi Pro (208 000 names) the modem hit 100 % load. Install deletes `/usrdata/qmanager/dnsguard/`; a `block` key left in `dnsguard.json` is ignored. For ad blocking without load, pick the AdGuard provider (it filters on its side).
- **Order of a switch-on:** start/restart the unit, wait up to 12 s for a fresh status, only then add the guard and the redirect. Switch-off removes the redirect first, then stops the unit. Custom DNS and DNS Privacy refuse to be on together (the redirect would bypass the custom servers). The DNS Mode gate of Custom DNS does not apply: the redirect works whatever resolver DHCP handed out.
- **Not `REDIRECT` for IPv4.** REDIRECT rewrites to the interface's first address; in IP Passthrough mode that is the carrier IP on `bridge0`, which the router also uses as its source, so replies never leave the modem (seen on hardware: 215 lookups redirected, 0 answered, LAN without DNS). DNAT to the private LAN address (192.168.225.1) is the path the web UI already uses and works.
- **Never a wildcard UDP socket.** An unbound UDP socket replies from the source the route picks; in IP Passthrough mode that is the carrier IP, the router drops it, and conntrack shows every lookup `[UNREPLIED]` while the forwarder counts them as answered (seen on hardware: 461 answered, LAN without DNS). Binding the LAN address fixes the source, as dnsmasq's `bind-interfaces` does.
- **End-to-end check.** After a switch-on the CGI waits up to 15 s for a redirected entry in `/proc/net/nf_conntrack` (reply `sport=5335`) that is not `[UNREPLIED]`; 3 or more entries and none replied → redirect removed, failed flag set, save returns `redirect_failed`. Without a readable connection table it falls back to "3+ redirected, `stats.queries` unchanged". The watchdog repeats this every 60 s (5+ entries, none replied; or 10+ redirected, none received).
- **Watchdog (poller, every 60 s):** unhealthy → restart at checks 1 and 3; from check 2 the redirect is removed (fail open, event `dns_privacy`); two healthy checks put it back. A redirect flushed by someone else (QCMAP re-applying its firewall) is put back on the next healthy check. Redirect rules do not survive a reboot; the watchdog adds them once the forwarder is healthy.
- **Uninstall** removes the redirect and guard chains before anything else, or LAN DNS breaks.
- **jq has no regex** on the device: domain validation in the CGI is awk.

# DNS Privacy (encrypted DNS + ad blocking)

> **Applies to:** RM520N-EU / RM520N-GL · tested off-device (Go tests, the ARM binary under qemu, BusyBox 1.31.1 CGI tests), not yet on hardware

`/local-network/dns-privacy` turns on DNS over TLS and/or domain block lists for every LAN device. An iptables nat rule redirects every DNS query arriving on `bridge0` (port 53, UDP + TCP, whatever server the device asked) to a local forwarder. dnsmasq is never edited, reloaded or restarted.

> **Never restart dnsmasq on the RM520N.** `systemctl restart dnsmasq_service@0` fails in IP Passthrough mode: QCMAP's config binds `interface=bridge0` with `bind-interfaces`, the passthrough address (the carrier IP, `/32` on `bridge0`) cannot be bound, and dnsmasq exits with status 2, leaving the LAN without DNS until a reboot. SIGHUP does not re-read `server=` / `no-resolv` either, which is why the first version (a `dnsmasq.conf` block) never took effect. Install and the poller strip that v1 block without a reload.

| Item | Value |
|------|-------|
| Forwarder | `dnsguard/` (Go, standard library only) → `/usrdata/qmanager/bin/qmanager_dnsguard`, built by `build-dnsguard.sh` |
| Unit | `qmanager-dnsguard.service` (gated, `MemoryLimit=48M`, `Restart=always`) |
| Listen | `:5335` UDP + TCP (IPv4 + IPv6); chain `QMANAGER_DNS` in `filter` drops `-i rmnet+` to 5335 |
| Redirect | `nat` chain `QMANAGER_DNS` (`-p udp/tcp --dport 53 -j REDIRECT --to-ports 5335`), hooked `PREROUTING -i bridge0` at position 1; IPv6 the same when `ip6tables` has a nat table (best effort, `service.active_ipv6`) |
| Local names | single-label names, `.lan` / `.localdomain` / `.home.arpa` / `.internal` and PTR of 10/8, 172.16/12, 192.168/16, 169.254/16 go to dnsmasq on the first private IPv4 of `bridge0` (`-local-dns auto`) |
| Config | `/etc/qmanager/dnsguard.json` — `encrypt {enabled, provider, fallback, nextdns_id, custom_host, custom_ip}`, `block {enabled, lists[≤3], allow[≤200], deny[≤200]}` |
| Status | `/tmp/qmanager_dnsguard.json` (every 15 s; `mem_kb` is VmRSS) |
| Flags | `/tmp/qmanager_dnsguard_reload`, `/tmp/qmanager_dnsguard_update` |
| Lists | `/usrdata/qmanager/dnsguard/<id>.txt`, downloaded with the system `curl`, refreshed daily; unselected lists are deleted |
| CGI | `network/dns_privacy.sh` — GET, POST `save` / `update_lists` / `allow` |
| Shared lib | `scripts/usr/lib/qmanager/dns_privacy.sh` (`dp_redirect`, `dp_guard_on/off`, `dp_legacy_cleanup`, `dns_privacy_watch`) |

- **Memory first (178 MB modem).** Block lists live in one sorted string plus `uint32` offsets (about the list's file size, ~2 MB for HaGeZi Light, ~5 MB for Pro), capped at 300 000 names; `SetMemoryLimit(32 MB)`, GC 50. No HTTP stack in the binary: DoT only, downloads via `curl`. Binary ~5 MB on `/usrdata`.
- **Encrypted DNS** is DoT to fixed provider IPs (no DNS needed to find DNS), certificates checked against the embedded Mozilla bundle. Before the clock is set (`< 1700000000`) TLS cannot verify; with `fallback` on, lookups go to the carrier resolvers from `/run/resolv.conf` or `/etc/resolv.conf` (loopback/local addresses skipped), otherwise SERVFAIL.
- **Blocking** answers A with `0.0.0.0`, AAAA with `::`, other types with no data, TTL 300. A listed name also blocks its subdomains; a bare TLD is never blocked. Allow beats the lists; deny beats nothing but allow.
- **Order of a switch-on:** start/restart the unit, wait up to 12 s for a fresh status, only then add the guard and the redirect. Switch-off removes the redirect first, then stops the unit. Custom DNS and DNS Privacy refuse to be on together (the redirect would bypass the custom servers). The DNS Mode gate of Custom DNS does not apply: the redirect works whatever resolver DHCP handed out.
- **Watchdog (poller, every 60 s):** unhealthy → restart at checks 1 and 3; from check 2 the redirect is removed (fail open, event `dns_privacy`); two healthy checks put it back. A redirect flushed by someone else (QCMAP re-applying its firewall) is put back on the next healthy check. Redirect rules do not survive a reboot; the watchdog adds them once the forwarder is healthy.
- **Uninstall** removes the redirect and guard chains before anything else, or LAN DNS breaks.
- **jq has no regex** on the device: domain validation in the CGI is awk.

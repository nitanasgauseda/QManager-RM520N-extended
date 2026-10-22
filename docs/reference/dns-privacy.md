# DNS Privacy (encrypted DNS + ad blocking)

> **Applies to:** RM520N-EU / RM520N-GL · tested off-device (Go tests, the ARM binary under qemu, BusyBox 1.31.1 CGI tests), not yet on hardware

`/local-network/dns-privacy` turns on DNS over TLS and/or domain block lists for every LAN device. dnsmasq stays the LAN resolver; a sentinel block in `/etc/data/dnsmasq.conf` points it at a local forwarder.

| Item | Value |
|------|-------|
| Forwarder | `dnsguard/` (Go, standard library only) → `/usrdata/qmanager/bin/qmanager_dnsguard`, built by `build-dnsguard.sh` |
| Unit | `qmanager-dnsguard.service` (gated, `MemoryLimit=48M`, `Restart=always`) |
| Listen | `127.0.0.1:5335` UDP + TCP |
| Config | `/etc/qmanager/dnsguard.json` — `encrypt {enabled, provider, fallback, nextdns_id, custom_host, custom_ip}`, `block {enabled, lists[≤3], allow[≤200], deny[≤200]}` |
| Status | `/tmp/qmanager_dnsguard.json` (every 15 s; `mem_kb` is VmRSS) |
| Flags | `/tmp/qmanager_dnsguard_reload`, `/tmp/qmanager_dnsguard_update` |
| Lists | `/usrdata/qmanager/dnsguard/<id>.txt`, downloaded with the system `curl`, refreshed daily; unselected lists are deleted |
| dnsmasq block | `# QMANAGER-DNSGUARD-BEGIN v1` / `no-resolv` / `server=127.0.0.1#5335` / `# QMANAGER-DNSGUARD-END v1` |
| CGI | `network/dns_privacy.sh` — GET, POST `save` / `update_lists` / `allow` |
| Shared lib | `scripts/usr/lib/qmanager/dns_privacy.sh` (`dp_write_block`, `dns_privacy_watch`) |

- **Memory first (178 MB modem).** Block lists live in one sorted string plus `uint32` offsets (about the list's file size, ~2 MB for HaGeZi Light, ~5 MB for Pro), capped at 300 000 names; `SetMemoryLimit(32 MB)`, GC 50. No HTTP stack in the binary: DoT only, downloads via `curl`. Binary ~5 MB on `/usrdata`.
- **Encrypted DNS** is DoT to fixed provider IPs (no DNS needed to find DNS), certificates checked against the embedded Mozilla bundle. Before the clock is set (`< 1700000000`) TLS cannot verify; with `fallback` on, lookups go to the carrier resolvers from `/run/resolv.conf` or `/etc/resolv.conf` (loopback/local addresses skipped), otherwise SERVFAIL.
- **Blocking** answers A with `0.0.0.0`, AAAA with `::`, other types with no data, TTL 300. A listed name also blocks its subdomains; a bare TLD is never blocked. Allow beats the lists; deny beats nothing but allow.
- **Order of a switch-on:** start/restart the unit, wait up to 12 s for a fresh status, only then write the dnsmasq block. Switch-off removes the block first, then stops the unit. Custom DNS and DNS Privacy refuse to be on together (two `server=` sets would leak).
- **Watchdog (poller, every 60 s):** unhealthy → restart at checks 1 and 3; from check 4 the block is removed (fail open, event `dns_privacy`); two healthy checks put it back.
- **Uninstall** strips the block and HUPs dnsmasq before anything else, or LAN DNS breaks.
- **jq has no regex** on the device: domain validation in the CGI is awk.

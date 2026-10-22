#!/bin/sh
# dns_privacy.sh — DNS Privacy (encrypted DNS + ad blocking) helpers shared by the CGI and the poller.
# LAN DNS (port 53 arriving on bridge0) is redirected to qmanager_dnsguard with an iptables nat rule.
# dnsmasq is never edited, reloaded or restarted: on the RM520N it cannot be restarted at all in
# IP Passthrough mode (it fails to bind the passthrough address). See docs/reference/dns-privacy.md.

[ -n "${_DNS_PRIVACY_LOADED:-}" ] && return 0
_DNS_PRIVACY_LOADED=1

: "${DP_CONFIG:=/etc/qmanager/dnsguard.json}"
: "${DP_STATUS:=/tmp/qmanager_dnsguard.json}"
: "${DP_DNSMASQ_CONF:=/etc/data/dnsmasq.conf}"
: "${DP_STAGING:=/etc/data/qmanager/dnsmasq.conf.new}"
: "${DP_PORT:=5335}"
: "${DP_LAN_IF:=bridge0}"
: "${QM_IPTABLES:=/usr/sbin/iptables}"
: "${QM_IP6TABLES:=/usr/sbin/ip6tables}"
: "${DP_FAILED_FLAG:=/etc/qmanager/dnsguard_redirect_failed}"
DP_CHAIN="QMANAGER_DNS"
# v1 forwarded through a block in dnsmasq.conf; only kept to clean it up.
DP_BEGIN="# QMANAGER-DNSGUARD-BEGIN v1"
DP_END="# QMANAGER-DNSGUARD-END v1"
DP_CUSTOM_BEGIN="# QMANAGER-CUSTOM-DNS-BEGIN v1"
DP_UNIT="qmanager-dnsguard"
DP_BIN="/usrdata/qmanager/bin/qmanager_dnsguard"

# Root runs the commands directly; www-data goes through its sudoers grants.
_dp_priv() {
    if [ "$(id -u 2>/dev/null)" = "0" ]; then "$@"; else sudo "$@"; fi
}

dp_wanted() {
    [ -f "$DP_CONFIG" ] || return 1
    [ "$(jq -r '(.encrypt.enabled == true) or (.block.enabled == true)' "$DP_CONFIG" 2>/dev/null)" = "true" ]
}

dp_custom_dns_active() { grep -qxF "$DP_CUSTOM_BEGIN" "$DP_DNSMASQ_CONF" 2>/dev/null; }

# Healthy: the daemon wrote its status within the last minute.
dp_daemon_healthy() {
    local upd now
    [ -s "$DP_STATUS" ] || return 1
    upd=$(jq -r '.updated // 0' "$DP_STATUS" 2>/dev/null)
    now=$(date +%s)
    case "$upd" in ''|*[!0-9]*) return 1 ;; esac
    [ $((now - upd)) -le 60 ]
}

_dp_tables() {
    echo "$QM_IPTABLES"
    command -v "$QM_IP6TABLES" >/dev/null 2>&1 && echo "$QM_IP6TABLES"
}

# Redirect present: the IPv4 PREROUTING hook exists.
dp_redirect_present() { _dp_priv "$QM_IPTABLES" -t nat -C PREROUTING -i "$DP_LAN_IF" -j "$DP_CHAIN" >/dev/null 2>&1; }

# The forwarder listens on every address; the cellular side must never reach it.
_dp_guard() {
    local t="$1"
    _dp_priv "$t" -N "$DP_CHAIN" >/dev/null 2>&1
    _dp_priv "$t" -F "$DP_CHAIN" >/dev/null 2>&1
    _dp_priv "$t" -A "$DP_CHAIN" -i rmnet+ -p udp --dport "$DP_PORT" -j DROP >/dev/null 2>&1 || return 1
    _dp_priv "$t" -A "$DP_CHAIN" -i rmnet+ -p tcp --dport "$DP_PORT" -j DROP >/dev/null 2>&1 || return 1
    _dp_priv "$t" -C INPUT -j "$DP_CHAIN" >/dev/null 2>&1 || _dp_priv "$t" -I INPUT 1 -j "$DP_CHAIN" >/dev/null 2>&1
}

dp_guard_on() { local t; for t in $(_dp_tables); do _dp_guard "$t"; done; return 0; }

dp_guard_off() {
    local t
    for t in $(_dp_tables); do
        while _dp_priv "$t" -C INPUT -j "$DP_CHAIN" >/dev/null 2>&1; do
            _dp_priv "$t" -D INPUT -j "$DP_CHAIN" >/dev/null 2>&1 || break
        done
        _dp_priv "$t" -F "$DP_CHAIN" >/dev/null 2>&1
        _dp_priv "$t" -X "$DP_CHAIN" >/dev/null 2>&1
    done
    return 0
}

# LAN IPv4 of bridge0 (192.168.225.1 by default). Not REDIRECT: that picks the interface's first
# address, which in IP Passthrough mode is the carrier IP the router also uses, so the reply never
# leaves the modem.
dp_lan_ip() {
    if [ -n "${DP_LAN_IP:-}" ]; then printf '%s' "$DP_LAN_IP"; return 0; fi
    ip -4 addr show dev "$DP_LAN_IF" 2>/dev/null | awk '
        $1 == "inet" { split($2, a, "/"); ip = a[1]; split(ip, o, ".")
            if (o[1] == 10 || (o[1] == 192 && o[2] == 168) || (o[1] == 172 && o[2] >= 16 && o[2] <= 31)) { print ip; exit } }'
}

# dp_redirect on|off — IPv4 only (the forwarder binds the LAN IPv4); on returns 0 once it is in place.
dp_redirect() {
    local t lan
    for t in $(_dp_tables); do
        while _dp_priv "$t" -t nat -C PREROUTING -i "$DP_LAN_IF" -j "$DP_CHAIN" >/dev/null 2>&1; do
            _dp_priv "$t" -t nat -D PREROUTING -i "$DP_LAN_IF" -j "$DP_CHAIN" >/dev/null 2>&1 || break
        done
        _dp_priv "$t" -t nat -F "$DP_CHAIN" >/dev/null 2>&1
        _dp_priv "$t" -t nat -X "$DP_CHAIN" >/dev/null 2>&1
    done
    [ "$1" = "on" ] || return 0
    lan=$(dp_lan_ip)
    [ -n "$lan" ] || return 1
    t="$QM_IPTABLES"
    _dp_priv "$t" -t nat -N "$DP_CHAIN" >/dev/null 2>&1 || return 1
    if _dp_priv "$t" -t nat -A "$DP_CHAIN" -p udp --dport 53 -j DNAT --to-destination "$lan:$DP_PORT" >/dev/null 2>&1 \
        && _dp_priv "$t" -t nat -A "$DP_CHAIN" -p tcp --dport 53 -j DNAT --to-destination "$lan:$DP_PORT" >/dev/null 2>&1 \
        && _dp_priv "$t" -t nat -I PREROUTING 1 -i "$DP_LAN_IF" -j "$DP_CHAIN" >/dev/null 2>&1; then
        return 0
    fi
    _dp_priv "$t" -t nat -F "$DP_CHAIN" >/dev/null 2>&1
    _dp_priv "$t" -t nat -X "$DP_CHAIN" >/dev/null 2>&1
    return 1
}

# The forwarder reports the addresses it bound; the redirect must point at one of them.
dp_lan_listening() {
    local lan
    lan=$(dp_lan_ip)
    [ -n "$lan" ] || return 1
    [ "$(jq -r --arg a "$lan:$DP_PORT" '(.listening // []) | index($a) != null' "$DP_STATUS" 2>/dev/null)" = "true" ]
}

# "total replied" for redirected lookups in the connection table (reply tuple from :5335).
dp_conntrack_stats() {
    local f="${DP_CONNTRACK:-/proc/net/nf_conntrack}"
    [ -r "$f" ] || { echo "- -"; return 0; }
    awk -v sp="sport=$DP_PORT " '/dport=53 / && index($0, sp) {
        n++; if ($0 !~ /UNREPLIED/) r++ } END { print n + 0, r + 0 }' "$f"
}

# Lookups the redirect sent (new flows seen by the IPv4 nat chain) and lookups the forwarder answered.
dp_redirect_pkts() {
    _dp_priv "$QM_IPTABLES" -t nat -L "$DP_CHAIN" -v -n -x 2>/dev/null \
        | awk '$1 ~ /^[0-9]+$/ { n += $1 } END { print n + 0 }'
}
dp_queries() { jq -r '.stats.queries // 0' "$DP_STATUS" 2>/dev/null || echo 0; }

# dp_verify_redirect — right after a switch-on: answers must go back out. If redirected lookups get
# no reply within ~15 s, take the redirect down again. Returns 1 only for that case.
dp_verify_redirect() {
    local q0 p q i=0 total replied
    q0=$(dp_queries)
    while [ "$i" -lt "${DP_VERIFY_STEPS:-5}" ]; do
        sleep "${DP_VERIFY_SLEEP:-3}"
        i=$((i + 1))
        set -- $(dp_conntrack_stats); replied=$2
        [ "$replied" != "-" ] && [ "$replied" -gt 0 ] && return 0
    done
    set -- $(dp_conntrack_stats); total=$1; replied=$2
    if [ "$total" != "-" ] && [ "$total" -ge 3 ]; then
        [ "$replied" -gt 0 ] && return 0
    else
        # No connection table to read: fall back to "lookups went in, none reached the forwarder".
        p=$(dp_redirect_pkts); q=$(dp_queries)
        { [ "${p:-0}" -lt 3 ] || [ "${q:-0}" -gt "${q0:-0}" ]; } && return 0
    fi
    dp_redirect off
    : > "$DP_FAILED_FLAG" 2>/dev/null
    return 1
}

# Strip a v1 dnsmasq block if one is left. No reload: the file only matters at dnsmasq's next start,
# and by then it must not point at a forwarder that may be off.
dp_legacy_cleanup() {
    grep -qxF "$DP_BEGIN" "$DP_DNSMASQ_CONF" 2>/dev/null || return 0
    awk -v b="$DP_BEGIN" -v e="$DP_END" '
        $0 == b { skip = 1; next }
        $0 == e && skip { skip = 0; next }
        !skip { print }' "$DP_DNSMASQ_CONF" > "$DP_STAGING" 2>/dev/null || { rm -f "$DP_STAGING"; return 1; }
    _dp_priv /bin/mv "$DP_STAGING" "$DP_DNSMASQ_CONF" || { rm -f "$DP_STAGING"; return 1; }
    _dp_priv /bin/chown radio:radio "$DP_DNSMASQ_CONF" 2>/dev/null
    return 0
}

# --- Poller watchdog: if the daemon dies, give LAN clients their DNS back; resume when it recovers.
# Also puts the redirect back when something (QCMAP re-applying its firewall) flushed it.
_dp_bad=0
_dp_good=0
_dp_next=0
_dp_failopen=0
_dp_cleaned=0
_dp_pk=-1
_dp_q=-1

dns_privacy_watch() {
    local up
    up=$(awk '{ print int($1) }' /proc/uptime 2>/dev/null)
    case "$up" in ''|*[!0-9]*) return 0 ;; esac
    [ "$up" -ge "$_dp_next" ] || return 0
    _dp_next=$((up + 60))
    command -v jq >/dev/null 2>&1 || return 0
    if [ "$_dp_cleaned" = "0" ]; then
        _dp_cleaned=1
        dp_legacy_cleanup
    fi
    if ! dp_wanted; then
        _dp_bad=0; _dp_good=0
        [ "$_dp_failopen" = "1" ] && _dp_failopen=0
        dp_redirect_present && dp_redirect off
        return 0
    fi
    if dp_daemon_healthy; then
        _dp_bad=0
        _dp_good=$((_dp_good + 1))
        # End to end: lookups redirected since the last check but none answered means the path is broken.
        if dp_redirect_present; then
            local pk q
            local ct
            pk=$(dp_redirect_pkts); q=$(dp_queries); ct=$(dp_conntrack_stats)
            if { [ "${ct%% *}" != "-" ] && [ "${ct%% *}" -ge 5 ] && [ "${ct#* }" -eq 0 ]; } \
                || { [ "$_dp_pk" -ge 0 ] && [ "$pk" -ge "$_dp_pk" ] && [ "$q" -ge "$_dp_q" ] \
                     && [ $((pk - _dp_pk)) -ge 10 ] && [ "$q" -eq "$_dp_q" ]; }; then
                dp_redirect off
                : > "$DP_FAILED_FLAG" 2>/dev/null
                _dp_pk=-1; _dp_q=-1
                command -v append_event >/dev/null 2>&1 \
                    && append_event "dns_privacy" "LAN lookups did not reach DNS Privacy, so it was switched off; devices use the carrier's DNS" "warning"
                return 0
            fi
            _dp_pk=$pk; _dp_q=$q
        else
            _dp_pk=-1; _dp_q=-1
        fi
        [ -f "$DP_FAILED_FLAG" ] && return 0
        if ! dp_redirect_present && { [ "$_dp_failopen" = "0" ] || [ "$_dp_good" -ge 2 ]; } \
            && ! dp_custom_dns_active && dp_lan_listening; then
            dp_guard_on
            if dp_redirect on; then
                [ "$_dp_failopen" = "1" ] && command -v append_event >/dev/null 2>&1 \
                    && append_event "dns_privacy" "DNS Privacy is working again" "info"
                _dp_failopen=0
            fi
        fi
        return 0
    fi
    _dp_good=0
    _dp_bad=$((_dp_bad + 1))
    # Fail open from the second bad check: a missing redirect costs nothing, a dead one costs all DNS.
    if [ "$_dp_bad" -eq 1 ] || [ "$_dp_bad" -eq 3 ]; then
        systemctl restart "$DP_UNIT" >/dev/null 2>&1
    fi
    if [ "$_dp_bad" -ge 2 ] && dp_redirect_present; then
        if dp_redirect off; then
            _dp_failopen=1
            command -v append_event >/dev/null 2>&1 \
                && append_event "dns_privacy" "DNS Privacy stopped answering; devices use the carrier's DNS until it recovers" "warning"
        fi
    fi
}

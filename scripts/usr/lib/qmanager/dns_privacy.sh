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

# Redirect present: the IPv4 PREROUTING hook exists (IPv6 is best effort and reported separately).
dp_redirect_present() { _dp_priv "$QM_IPTABLES" -t nat -C PREROUTING -i "$DP_LAN_IF" -j "$DP_CHAIN" >/dev/null 2>&1; }
dp_redirect6_present() {
    command -v "$QM_IP6TABLES" >/dev/null 2>&1 || return 1
    _dp_priv "$QM_IP6TABLES" -t nat -C PREROUTING -i "$DP_LAN_IF" -j "$DP_CHAIN" >/dev/null 2>&1
}

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

# dp_redirect on|off — on returns 0 only when the IPv4 redirect is in place.
dp_redirect() {
    local t ok=0
    for t in $(_dp_tables); do
        while _dp_priv "$t" -t nat -C PREROUTING -i "$DP_LAN_IF" -j "$DP_CHAIN" >/dev/null 2>&1; do
            _dp_priv "$t" -t nat -D PREROUTING -i "$DP_LAN_IF" -j "$DP_CHAIN" >/dev/null 2>&1 || break
        done
        _dp_priv "$t" -t nat -F "$DP_CHAIN" >/dev/null 2>&1
        _dp_priv "$t" -t nat -X "$DP_CHAIN" >/dev/null 2>&1
    done
    [ "$1" = "on" ] || return 0
    for t in $(_dp_tables); do
        _dp_priv "$t" -t nat -N "$DP_CHAIN" >/dev/null 2>&1 || continue
        if _dp_priv "$t" -t nat -A "$DP_CHAIN" -p udp --dport 53 -j REDIRECT --to-ports "$DP_PORT" >/dev/null 2>&1 \
            && _dp_priv "$t" -t nat -A "$DP_CHAIN" -p tcp --dport 53 -j REDIRECT --to-ports "$DP_PORT" >/dev/null 2>&1 \
            && _dp_priv "$t" -t nat -I PREROUTING 1 -i "$DP_LAN_IF" -j "$DP_CHAIN" >/dev/null 2>&1; then
            [ "$t" = "$QM_IPTABLES" ] && ok=1
        else
            _dp_priv "$t" -t nat -F "$DP_CHAIN" >/dev/null 2>&1
            _dp_priv "$t" -t nat -X "$DP_CHAIN" >/dev/null 2>&1
        fi
    done
    [ "$ok" = "1" ]
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
        if ! dp_redirect_present && { [ "$_dp_failopen" = "0" ] || [ "$_dp_good" -ge 2 ]; } \
            && ! dp_custom_dns_active; then
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

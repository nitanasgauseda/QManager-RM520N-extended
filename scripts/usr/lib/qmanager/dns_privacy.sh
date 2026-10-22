#!/bin/sh
# dns_privacy.sh — DNS Privacy (encrypted DNS + ad blocking) helpers shared by the CGI and the poller.
# dnsmasq forwards LAN queries to qmanager_dnsguard through a sentinel block in /etc/data/dnsmasq.conf,
# written with the same staged mv + chown + HUP pipeline as Custom DNS. See docs/reference/dns-privacy.md.

[ -n "${_DNS_PRIVACY_LOADED:-}" ] && return 0
_DNS_PRIVACY_LOADED=1

: "${DP_CONFIG:=/etc/qmanager/dnsguard.json}"
: "${DP_STATUS:=/tmp/qmanager_dnsguard.json}"
: "${DP_DNSMASQ_CONF:=/etc/data/dnsmasq.conf}"
: "${DP_STAGING:=/etc/data/qmanager/dnsmasq.conf.new}"
: "${DP_LISTEN:=127.0.0.1#5335}"
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

dp_block_present() { grep -qxF "$DP_BEGIN" "$DP_DNSMASQ_CONF" 2>/dev/null; }
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

# dp_write_block on|off — add or remove our block; returns 0 once the new file is in place.
dp_write_block() {
    local want="$1" lock=/tmp/qmanager_dnsmasq_conf.lock i=0
    [ -f "$DP_DNSMASQ_CONF" ] || return 1
    while ! mkdir "$lock" 2>/dev/null; do
        i=$((i + 1))
        [ "$i" -ge 50 ] && { rm -rf "$lock"; break; }
        sleep 0.1 2>/dev/null || sleep 1
    done
    {
        awk -v b="$DP_BEGIN" -v e="$DP_END" '
            $0 == b { skip = 1; next }
            $0 == e && skip { skip = 0; next }
            !skip { print }' "$DP_DNSMASQ_CONF"
        if [ "$want" = "on" ]; then
            printf '%s\nno-resolv\nserver=%s\n%s\n' "$DP_BEGIN" "$DP_LISTEN" "$DP_END"
        fi
    } > "$DP_STAGING" 2>/dev/null || { rm -f "$DP_STAGING"; rmdir "$lock" 2>/dev/null; return 1; }
    if ! dnsmasq --test --conf-file="$DP_STAGING" >/dev/null 2>&1; then
        rm -f "$DP_STAGING"; rmdir "$lock" 2>/dev/null; return 1
    fi
    if ! _dp_priv /bin/mv "$DP_STAGING" "$DP_DNSMASQ_CONF"; then
        rm -f "$DP_STAGING"; rmdir "$lock" 2>/dev/null; return 1
    fi
    _dp_priv /bin/chown radio:radio "$DP_DNSMASQ_CONF" 2>/dev/null
    rmdir "$lock" 2>/dev/null
    # The file is in place; a failed HUP only delays it to dnsmasq's next start.
    if ! _dp_priv /usr/bin/killall -HUP dnsmasq >/dev/null 2>&1; then
        command -v qlog_warn >/dev/null 2>&1 && qlog_warn "dns privacy: killall -HUP dnsmasq failed"
    fi
    return 0
}

# --- Poller watchdog: if the daemon dies, give LAN clients their DNS back; resume when it recovers.
_dp_bad=0
_dp_good=0
_dp_next=0
_dp_failopen=0

dns_privacy_watch() {
    local up
    up=$(awk '{ print int($1) }' /proc/uptime 2>/dev/null)
    case "$up" in ''|*[!0-9]*) return 0 ;; esac
    [ "$up" -ge "$_dp_next" ] || return 0
    _dp_next=$((up + 60))
    command -v jq >/dev/null 2>&1 || return 0
    if ! dp_wanted; then
        _dp_bad=0; _dp_good=0
        [ "$_dp_failopen" = "1" ] && _dp_failopen=0
        return 0
    fi
    if dp_daemon_healthy; then
        _dp_bad=0
        _dp_good=$((_dp_good + 1))
        if ! dp_block_present && [ "$_dp_good" -ge 2 ] && ! dp_custom_dns_active; then
            if dp_write_block on; then
                [ "$_dp_failopen" = "1" ] && command -v append_event >/dev/null 2>&1 \
                    && append_event "dns_privacy" "DNS Privacy is working again" "info"
                _dp_failopen=0
            fi
        fi
        return 0
    fi
    _dp_good=0
    _dp_bad=$((_dp_bad + 1))
    if [ "$_dp_bad" -eq 1 ] || [ "$_dp_bad" -eq 3 ]; then
        systemctl restart "$DP_UNIT" >/dev/null 2>&1
    elif [ "$_dp_bad" -ge 4 ] && dp_block_present; then
        if dp_write_block off; then
            _dp_failopen=1
            command -v append_event >/dev/null 2>&1 \
                && append_event "dns_privacy" "DNS Privacy stopped answering; devices use the carrier's DNS until it recovers" "warning"
        fi
    fi
}

#!/bin/sh
# watch.sh — light checks the poller runs every cycle: SIM change, roaming (alert and optional
# data block), public IP / carrier NAT, outage log and the monthly report.
# Sourced by qmanager_poller; call watch_check once per cycle. See docs/reference/watch.md.

[ -n "${_WATCH_LOADED:-}" ] && return 0
_WATCH_LOADED=1

: "${WT_CONFIG:=/etc/qmanager/watch.json}"
: "${WT_STATUS:=/tmp/qmanager_watch.json}"
: "${WT_PUBIP:=/tmp/qmanager_pubip.json}"
: "${WT_OUTAGES:=/etc/qmanager/outages.log}"
: "${WT_OPEN:=/tmp/qmanager_outage_open}"
: "${WT_MONTH:=/etc/qmanager/watch_month.json}"
: "${WT_HIST_DIR:=/usrdata/qmanager/sighist}"
: "${WT_RELOAD_FLAG:=/tmp/qmanager_watch_reload}"
: "${WT_SIM_FLAG:=/tmp/qmanager_sim_swap_detected}"
: "${WT_IPT:=/usr/sbin/iptables}"
: "${WT_IP_URLS:=https://api.ipify.org https://ipv4.icanhazip.com}"
WT_ROAM_CHAIN="QMANAGER_ROAM"
WT_ROAM_EVERY=120
WT_IP_EVERY=1800
WT_MONTH_EVERY=600
WT_OUTAGE_MAX=2000

_wt_loaded=0
_wt_roam_alert=true; _wt_roam_block=false; _wt_ip_on=true
_wt_roam_next=0; _wt_roam_state=unknown; _wt_roam_pending=""; _wt_roam_since=0
_wt_ip_next=0; _wt_ip_wan=""; _wt_ip_public=""; _wt_ip_seen=0
_wt_iccid=""; _wt_sim_in=""; _wt_sim_boot_done=0
_wt_net=""; _wt_month_next=0; _wt_fw_next=0

_wt_up() { local u r; read -r u r < /proc/uptime 2>/dev/null; printf '%s' "${u%%.*}"; }
_wt_clock_ok() { [ "$(date +%s)" -ge 1700000000 ]; }

_wt_alert() {
    local event="$1" msg="$2" ch
    command -v _ae_effective_send >/dev/null 2>&1 || return 0
    for ch in sms email telegram discord; do
        _ae_effective_send "$event" "$ch" && _ae_dispatch "$ch" "$event" "$msg"
    done
    return 0
}

_wt_event() { command -v append_event >/dev/null 2>&1 && append_event "$1" "$2" "${3:-info}"; return 0; }

wt_load_config() {
    _wt_roam_alert=true; _wt_roam_block=false; _wt_ip_on=true
    if [ -f "$WT_CONFIG" ]; then
        local v
        v=$(jq -r '[(.roaming.alert != false), (.roaming.block == true), (.public_ip.enabled != false)] | map(tostring) | join(" ")' "$WT_CONFIG" 2>/dev/null)
        set -- $v
        [ "$1" = "false" ] && _wt_roam_alert=false
        [ "$2" = "true" ] && _wt_roam_block=true
        [ "$3" = "false" ] && _wt_ip_on=false
    fi
    _wt_loaded=1
}

# --- SIM -------------------------------------------------------------------------
_wt_check_sim() {
    local cur="${boot_iccid:-}" tail_new tail_old
    # The poller's boot check found a SIM it has never seen: alert once per boot.
    if [ "$_wt_sim_boot_done" = "0" ]; then
        _wt_sim_boot_done=1
        if [ -f "$WT_SIM_FLAG" ] && [ "$(jq -r '.dismissed == true' "$WT_SIM_FLAG" 2>/dev/null)" != "true" ]; then
            _wt_alert sim_change "A new SIM card is in the modem (ICCID ...$(printf '%s' "$cur" | tail -c 4))."
        fi
    fi
    if [ -n "$cur" ] && [ -n "$_wt_iccid" ] && [ "$cur" != "$_wt_iccid" ]; then
        tail_new=$(printf '%s' "$cur" | tail -c 4); tail_old=$(printf '%s' "$_wt_iccid" | tail -c 4)
        _wt_event "sim_change" "SIM card changed (ICCID ...$tail_old to ...$tail_new, slot ${t2_sim_slot:-1})" "warning"
        _wt_alert sim_change "The SIM card changed: ICCID ...$tail_old is now ...$tail_new (slot ${t2_sim_slot:-1})."
    fi
    [ -n "$cur" ] && _wt_iccid="$cur"
    # A SIM pulled out while the modem runs.
    case "${t2_sim_inserted:-}" in
        true|false)
            if [ "$_wt_sim_in" = "true" ] && [ "$t2_sim_inserted" = "false" ]; then
                _wt_event "sim_change" "SIM card removed" "warning"
                _wt_alert sim_change "The SIM card was removed from the modem."
            fi
            _wt_sim_in="$t2_sim_inserted"
            ;;
    esac
}

# --- Roaming ---------------------------------------------------------------------
# stat 5 in +CEREG (LTE), +C5GREG (5G SA) or +CREG means registered while roaming.
_wt_reg_stat() {
    local cmd out st
    command -v qcmd >/dev/null 2>&1 || return 1
    # One command at a time: an unsupported one (C5GREG on LTE firmware) fails a whole chain.
    for cmd in 'AT+CEREG?' 'AT+C5GREG?' 'AT+CREG?'; do
        out=$(qcmd "$cmd" 2>/dev/null) || continue
        st=$(printf '%s\n' "$out" | tr -d '\r ' | awk -F'[:,]' '/^\+C(E|5G)?REG:/ { print $3 + 0; exit }')
        case "$st" in 1|5) printf '%s' "$st"; return 0 ;; esac
    done
    return 1
}

_wt_block() {
    local t="$WT_IPT"
    if [ "$1" = "on" ]; then
        $t -N "$WT_ROAM_CHAIN" >/dev/null 2>&1
        $t -F "$WT_ROAM_CHAIN" >/dev/null 2>&1
        $t -A "$WT_ROAM_CHAIN" -o rmnet+ -j DROP >/dev/null 2>&1
        $t -C FORWARD -j "$WT_ROAM_CHAIN" >/dev/null 2>&1 || $t -I FORWARD 1 -j "$WT_ROAM_CHAIN" >/dev/null 2>&1
    else
        while $t -C FORWARD -j "$WT_ROAM_CHAIN" >/dev/null 2>&1; do
            $t -D FORWARD -j "$WT_ROAM_CHAIN" >/dev/null 2>&1 || break
        done
        $t -F "$WT_ROAM_CHAIN" >/dev/null 2>&1
        $t -X "$WT_ROAM_CHAIN" >/dev/null 2>&1
    fi
}
_wt_blocked() { $WT_IPT -C FORWARD -j "$WT_ROAM_CHAIN" >/dev/null 2>&1; }
_wt_block_on=0

_wt_check_roaming() {
    local up="$1" st new checked=0
    if [ "$up" -ge "$_wt_roam_next" ]; then
        _wt_roam_next=$((up + WT_ROAM_EVERY))
        checked=1
        st=$(_wt_reg_stat)
        case "$st" in 5) new=roaming ;; 1) new=home ;; *) new="" ;; esac
        # Two readings in a row before a change counts, so one odd reply cannot block data.
        if [ -n "$new" ] && [ "$new" != "$_wt_roam_state" ]; then
            if [ "$_wt_roam_pending" = "$new" ] || [ "$_wt_roam_state" = "unknown" ]; then
                local was="$_wt_roam_state"
                _wt_roam_state="$new"; _wt_roam_pending=""; _wt_roam_since=$(date +%s)
                if [ "$new" = "roaming" ]; then
                    _wt_event "roaming" "Roaming on ${t2_carrier:-another network}" "warning"
                    [ "$_wt_roam_alert" = "true" ] && _wt_alert roaming "The modem is roaming on ${t2_carrier:-another network}.$([ "$_wt_roam_block" = "true" ] && printf ' Data for your devices is blocked until it is back home.')"
                elif [ "$was" = "roaming" ]; then
                    _wt_event "roaming" "Back on the home network" "info"
                fi
            else
                _wt_roam_pending="$new"
            fi
        elif [ "$new" = "$_wt_roam_state" ]; then
            _wt_roam_pending=""
        fi
    fi
    # Keep the block in step with the setting; re-checked with iptables only every WT_ROAM_EVERY.
    if [ "$_wt_roam_state" = "roaming" ] && [ "$_wt_roam_block" = "true" ]; then
        if [ "$_wt_block_on" = "0" ] || [ "$checked" = "1" ]; then
            _wt_blocked || _wt_block on
            _wt_block_on=1
        fi
    elif [ "$_wt_block_on" = "1" ] || [ "$checked" = "1" ]; then
        _wt_blocked && _wt_block off
        _wt_block_on=0
    fi
}

# --- Public IP -------------------------------------------------------------------
_wt_private() {
    printf '%s' "$1" | awk -F. 'NF != 4 { exit 1 }
        { a = $1 + 0; b = $2 + 0
          if (a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 100 && b >= 64 && b <= 127)) exit 0
          exit 1 }'
}

# The lookup runs in the background; the next cycles pick up its result file.
_wt_ip_fetch() {
    (
        ip=""
        for u in $WT_IP_URLS; do
            ip=$(curl -s4 --max-time 10 "$u" 2>/dev/null | tr -d ' \r\n')
            printf '%s' "$ip" | awk -F. 'NF == 4 { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i + 0 > 255) exit 1; exit 0 } { exit 1 }' && break
            ip=""
        done
        printf '%s %s\n' "$(date +%s)" "$ip" > "$WT_PUBIP.raw.tmp" && mv "$WT_PUBIP.raw.tmp" "$WT_PUBIP.raw"
    ) >/dev/null 2>&1 &
}

_wt_check_ip() {
    local up="$1" wan="${t2_wan_ipv4:-}" ts ip cgnat prev
    [ "$_wt_ip_on" = "true" ] || return 0
    command -v curl >/dev/null 2>&1 || return 0
    if [ "${conn_internet_available:-}" = "true" ] && _wt_clock_ok \
        && { [ "$up" -ge "$_wt_ip_next" ] || [ "$wan" != "$_wt_ip_wan" ]; }; then
        _wt_ip_next=$((up + WT_IP_EVERY))
        _wt_ip_wan="$wan"
        _wt_ip_fetch
    fi
    [ -s "$WT_PUBIP.raw" ] || return 0
    read -r ts ip < "$WT_PUBIP.raw" 2>/dev/null
    [ "${ts:-0}" -gt "$_wt_ip_seen" ] 2>/dev/null || return 0
    _wt_ip_seen="$ts"
    [ -n "$ip" ] || { printf '{"checked_at":%s,"public_ipv4":null,"wan_ipv4":"%s","cgnat":null,"error":"lookup_failed"}\n' "$ts" "$wan" > "$WT_PUBIP"; return 0; }
    cgnat=false
    { [ "$ip" != "$wan" ] || _wt_private "$wan"; } && cgnat=true
    prev="$_wt_ip_public"
    printf '{"checked_at":%s,"public_ipv4":"%s","wan_ipv4":"%s","cgnat":%s,"error":null}\n' "$ts" "$ip" "$wan" "$cgnat" > "$WT_PUBIP.tmp" \
        && mv "$WT_PUBIP.tmp" "$WT_PUBIP"
    _wt_ip_public="$ip"
    if [ -n "$prev" ] && [ "$prev" != "$ip" ]; then
        _wt_event "public_ip_changed" "Public IP changed from $prev to $ip" "info"
        _wt_alert ip_change "Your public IP address changed from $prev to $ip."
    fi
}

# --- Outages -----------------------------------------------------------------------
_wt_check_outage() {
    local now st enb net
    case "${conn_internet_available:-}" in true|false) ;; *) return 0 ;; esac
    if [ -z "$_wt_net" ]; then
        # First reading: an outage open before a poller restart carries on.
        _wt_net="$conn_internet_available"
        [ "$_wt_net" = "true" ] && [ -s "$WT_OPEN" ] && _wt_net=false
    fi
    [ "$conn_internet_available" = "$_wt_net" ] && return 0
    _wt_clock_ok || { _wt_net="$conn_internet_available"; return 0; }
    now=$(date +%s)
    if [ "$conn_internet_available" = "false" ]; then
        printf '%s %s %s\n' "$now" "${lte_enodeb_id:--}" "${network_type:--}" > "$WT_OPEN"
    elif [ -s "$WT_OPEN" ]; then
        read -r st enb net < "$WT_OPEN"
        case "$st" in ''|*[!0-9]*) ;; *)
            [ "$now" -gt "$st" ] && printf '%s %s %s %s\n' "$st" "$now" "${enb:--}" "${net:--}" >> "$WT_OUTAGES"
            if [ "$(wc -l < "$WT_OUTAGES" 2>/dev/null)" -gt $((WT_OUTAGE_MAX + 200)) ]; then
                tail -n "$WT_OUTAGE_MAX" "$WT_OUTAGES" > "$WT_OUTAGES.tmp" && mv "$WT_OUTAGES.tmp" "$WT_OUTAGES"
            fi
            ;;
        esac
        rm -f "$WT_OPEN"
    fi
    _wt_net="$conn_internet_available"
}

# --- Monthly report ----------------------------------------------------------------
# wt_month_report <YYYY-MM> <rx_bytes> <tx_bytes> — the text, built from the outage log and signal history.
wt_month_report() {
    local month="$1" rx="$2" tx="$3" from to secs d0 d1 out sig
    from=$(date -d "$month-01 00:00:00" +%s 2>/dev/null) || return 1
    to=$(date -d "$(awk -v m="$month" 'BEGIN { split(m, a, "-"); y = a[1] + 0; n = a[2] + 1; if (n > 12) { n = 1; y++ } printf "%04d-%02d-01 00:00:00", y, n }')" +%s 2>/dev/null) || return 1
    secs=$((to - from))
    out=$(awk -v f="$from" -v t="$to" '
        $1 >= f && $1 < t { n++; d = $2 - $1; tot += d; if (d > mx) mx = d }
        END { printf "%d %d %d", n, tot, mx }' "$WT_OUTAGES" 2>/dev/null)
    [ -n "$out" ] || out="0 0 0"
    d0=$((from / 86400)); d1=$(((to - 1) / 86400))
    sig=$(i=$d0; while [ "$i" -le "$d1" ]; do [ -f "$WT_HIST_DIR/d$i.csv" ] && cat "$WT_HIST_DIR/d$i.csv"; i=$((i + 1)); done 2>/dev/null \
        | awk -F, '$1 ~ /^[0-9]+$/ {
            if ($6 != "") { rs += $6; rn++ } if ($8 != "") { ss += $8; sn++ }
            if ($5 != "") { c[$5]++; cn++ } }
          END { best = ""; bn = 0; for (k in c) if (c[k] > bn) { bn = c[k]; best = k }
                printf "%s %s %s %d", (rn ? sprintf("%.0f", rs / rn) : "-"), (sn ? sprintf("%.0f", ss / sn) : "-"), (best == "" ? "-" : best), (cn ? bn * 100 / cn : 0) }')
    [ -n "$sig" ] || sig="- - - 0"
    awk -v month="$month" -v rx="$rx" -v tx="$tx" -v secs="$secs" -v o="$out" -v s="$sig" 'BEGIN {
        split(o, a, " "); split(s, b, " ")
        split("January February March April May June July August September October November December", mn, " ")
        split(month, ym, "-")
        gb = (rx + tx) / 1073741824
        avail = (secs > 0) ? 100 - a[2] * 100 / secs : 100
        printf "Monthly report for %s %s\n", mn[ym[2] + 0], ym[1]
        printf "Data: %.1f GB (down %.1f GB, up %.1f GB)\n", gb, rx / 1073741824, tx / 1073741824
        if (a[1] > 0) printf "Internet: %.2f %% available, %d outages, %d min down in total (longest %d min)\n", avail, a[1], int((a[2] + 59) / 60), int((a[3] + 59) / 60)
        else printf "Internet: no outages\n"
        if (b[1] != "-") printf "Signal: average RSRP %s dBm, SINR %s dB\n", b[1], b[2]
        if (b[3] != "-") printf "Main cell: eNB %s (%d %% of the time)\n", b[3], b[4]
    }'
}

_wt_check_month() {
    local up="$1" month rx tx prev prx ptx text urx utx
    [ "$up" -ge "$_wt_month_next" ] || return 0
    _wt_month_next=$((up + WT_MONTH_EVERY))
    _wt_clock_ok || return 0
    month=$(date +%Y-%m)
    rx="${du_accumulated_rx:-0}"; tx="${du_accumulated_tx:-0}"
    if [ -s "$WT_MONTH" ]; then
        set -- $(jq -r '"\(.month // "") \(.rx // 0) \(.tx // 0)"' "$WT_MONTH" 2>/dev/null)
        prev="$1"; prx="${2:-0}"; ptx="${3:-0}"
    fi
    [ "$prev" = "$month" ] && return 0
    if [ -n "$prev" ]; then
        # A Data Used reset during the month: count from zero rather than go negative.
        urx=$((rx - prx)); utx=$((tx - ptx))
        [ "$urx" -ge 0 ] || urx="$rx"; [ "$utx" -ge 0 ] || utx="$tx"
        text=$(wt_month_report "$prev" "$urx" "$utx")
        [ -n "$text" ] && { _wt_event "monthly_report" "Monthly report for $prev sent" "info"; _wt_alert monthly_report "$text"; }
    fi
    printf '{"month":"%s","rx":%s,"tx":%s}\n' "$month" "$rx" "$tx" > "$WT_MONTH.tmp" && mv "$WT_MONTH.tmp" "$WT_MONTH"
}

_wt_write_status() {
    local blocked=false
    _wt_blocked && blocked=true
    printf '{"updated":%s,"roaming":{"state":"%s","since":%s,"alert":%s,"block":%s,"blocked":%s},"public_ip":{"enabled":%s}}\n' \
        "$(date +%s)" "$_wt_roam_state" "${_wt_roam_since:-0}" "$_wt_roam_alert" "$_wt_roam_block" "$blocked" "$_wt_ip_on" \
        > "$WT_STATUS.tmp" 2>/dev/null && mv "$WT_STATUS.tmp" "$WT_STATUS"
}

# Stealth / LAN IPv6 rules: a QCMAP re-dial flushes iptables, so put them back every 2 minutes.
_wt_check_fw() {
    [ "$1" -ge "$_wt_fw_next" ] || return 0
    _wt_fw_next=$(($1 + 120))
    [ -f "${QM_STEALTH_FLAG:-/etc/qmanager/wan_stealth}" ] || [ -f "${QM_LAN6_OFF_FLAG:-/etc/qmanager/lan_ipv6_off}" ] || return 0
    [ -x "${WT_FIREWALL:-/usr/bin/qmanager_firewall}" ] && "${WT_FIREWALL:-/usr/bin/qmanager_firewall}" ensure >/dev/null 2>&1
}

watch_check() {
    local up before
    if [ "$_wt_loaded" != "1" ] || [ -f "$WT_RELOAD_FLAG" ]; then
        rm -f "$WT_RELOAD_FLAG" 2>/dev/null
        wt_load_config
        _wt_roam_next=0; _wt_ip_next=0
    fi
    up=$(_wt_up)
    case "$up" in ''|*[!0-9]*) return 0 ;; esac
    command -v jq >/dev/null 2>&1 || return 0
    before="$_wt_roam_state"
    _wt_check_outage
    _wt_check_sim
    [ "${modem_reachable:-true}" = "true" ] && _wt_check_roaming "$up"
    _wt_check_ip "$up"
    _wt_check_month "$up"
    _wt_check_fw "$up"
    if [ "$before" != "$_wt_roam_state" ] || [ ! -f "$WT_STATUS" ] || [ $((${cycle_count:-0} % 60)) -eq 0 ]; then
        _wt_write_status
    fi
}

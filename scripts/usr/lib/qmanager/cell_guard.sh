#!/bin/sh
# cell_guard.sh — fake base station (IMSI catcher) heuristics, sourced by qmanager_poller.
# Acts only when the serving cell's identity changes, so it costs nothing on a steady link.
# Findings become "suspicious_cell" events and go out through alert_engine.sh routing.
# See docs/reference/cell-guard.md.

[ -n "${_CELL_GUARD_LOADED:-}" ] && return 0
_CELL_GUARD_LOADED=1

: "${CG_CONFIG:=/etc/qmanager/cell_guard.json}"
: "${CG_KNOWN:=/etc/qmanager/cell_guard_known}"
: "${CG_SINCE:=/etc/qmanager/cell_guard_since}"
: "${CG_TOWER_DIR:=/etc/qmanager/towers}"
: "${CG_TOWER_CONF:=/etc/qmanager/tower_map.json}"
: "${CG_STATUS:=/tmp/qmanager_cell_guard.json}"
: "${CG_RAYHUNTER_URL:=http://127.0.0.1:8686}"
CG_RELOAD_FLAG="/tmp/qmanager_cell_guard_reload"
CG_MAX_KNOWN=3000
CG_ALERT_GAP_SECS=600
CG_SANE_EPOCH=1700000000

_cg_enabled="true"
_cg_learn_hours=24
_cg_rayhunter="false"
_cg_cfg_loaded=0
_cg_last_sig=""
_cg_last_rat=""
_cg_last_alert_up=-100000
_cg_suppressed=0
_cg_rh_tick=0
_cg_rh_entry=""
_cg_rh_seen=0
_cg_last_finding=""

_cg_up() { awk '{ print int($1) }' /proc/uptime 2>/dev/null; }

cg_load_config() {
    command -v jq >/dev/null 2>&1 || return 1
    _cg_enabled="true"; _cg_learn_hours=24; _cg_rayhunter="false"
    if [ -f "$CG_CONFIG" ]; then
        _cg_enabled=$(jq -r 'if .enabled == false then "false" else "true" end' "$CG_CONFIG" 2>/dev/null)
        _cg_learn_hours=$(jq -r '.learn_hours // 24' "$CG_CONFIG" 2>/dev/null)
        _cg_rayhunter=$(jq -r 'if .rayhunter == true then "true" else "false" end' "$CG_CONFIG" 2>/dev/null)
    fi
    case "$_cg_learn_hours" in ''|*[!0-9]*) _cg_learn_hours=24 ;; esac
    case "$_cg_enabled" in true|false) ;; *) _cg_enabled="true" ;; esac
    _cg_cfg_loaded=1
}

# Learning window: cells first seen in the first N hours are the baseline, not findings.
_cg_learning() {
    local now since
    now=$(date +%s)
    [ "$now" -ge "$CG_SANE_EPOCH" ] 2>/dev/null || return 0
    if [ ! -s "$CG_SINCE" ]; then
        printf '%s' "$now" > "$CG_SINCE" 2>/dev/null
        return 0
    fi
    since=$(cat "$CG_SINCE" 2>/dev/null)
    case "$since" in ''|*[!0-9]*) return 0 ;; esac
    [ $((now - since)) -lt $((_cg_learn_hours * 3600)) ]
}

# _cg_in_db <mcc> <mnc> <radio L|N> <id> — tower known to the local OpenCelliD index or corrected by the user.
_cg_in_db() {
    local f="$CG_TOWER_DIR/$1.json" hit
    if [ -f "$CG_TOWER_CONF" ]; then
        hit=$(jq -r --arg k "$1-$2-$4" '(.overrides // {}) | has($k)' "$CG_TOWER_CONF" 2>/dev/null)
        [ "$hit" = "true" ] && return 0
    fi
    [ -s "$f" ] || return 2
    hit=$(jq -r --arg r "$3" --argjson m "$2" --argjson e "$4" \
        'any(.towers[]; .r == $r and .m == $m and .e == $e)' "$f" 2>/dev/null)
    [ "$hit" = "true" ]
}

# _cg_tower_pos <mcc> <mnc> <radio> <id> — "lat lon" (user correction wins), or nothing.
_cg_tower_pos() {
    local p=""
    [ -f "$CG_TOWER_CONF" ] && p=$(jq -r --arg k "$1-$2-$4" \
        '(.overrides // {})[$k] // empty | "\(.lat) \(.lon)"' "$CG_TOWER_CONF" 2>/dev/null)
    if [ -z "$p" ] && [ -s "$CG_TOWER_DIR/$1.json" ]; then
        p=$(jq -r --arg r "$3" --argjson m "$2" --argjson e "$4" \
            'first(.towers[] | select(.r == $r and .m == $m and .e == $e) | "\(.la) \(.lo)") // empty' \
            "$CG_TOWER_DIR/$1.json" 2>/dev/null)
    fi
    printf '%s' "$p"
}

_cg_home() {
    [ -f "$CG_TOWER_CONF" ] && jq -r '.home // empty | "\(.lat) \(.lon)"' "$CG_TOWER_CONF" 2>/dev/null
}

# Haversine in metres between "lat lon" pairs. jq, not awk: BusyBox awk can be built without math.
_cg_dist() {
    jq -n -r --arg a "$1" --arg b "$2" '
        ($a | split(" ") | map(tonumber)) as $p | ($b | split(" ") | map(tonumber)) as $q
        | (3.14159265358979 / 180) as $r
        | ((($q[0] - $p[0]) * $r) / 2 | sin) as $sa | ((($q[1] - $p[1]) * $r) / 2 | sin) as $so
        | ($sa * $sa + (($p[0] * $r) | cos) * (($q[0] * $r) | cos) * $so * $so) as $h
        | 2 * 6371008.8 * ($h | sqrt | asin) | floor' 2>/dev/null
}

_cg_status_write() {
    local known=0 learning=false
    [ -f "$CG_KNOWN" ] && known=$(wc -l < "$CG_KNOWN" 2>/dev/null | tr -d ' ')
    _cg_learning && learning=true
    jq -n -c --argjson known "${known:-0}" --argjson learning "$learning" \
        --arg since "$(cat "$CG_SINCE" 2>/dev/null)" --arg enabled "$_cg_enabled" \
        --arg last "$_cg_last_finding" --arg rh "$_cg_rayhunter" --arg rhe "$_cg_rh_entry" \
        --argjson rhn "$_cg_rh_seen" --argjson ts "$(date +%s)" \
        '{enabled: ($enabled == "true"), learning: $learning, since: ($since | tonumber? // null),
          known_cells: $known, last_finding: $last, updated: $ts,
          rayhunter: {enabled: ($rh == "true"), recording: $rhe, warnings: $rhn}}' \
        > "${CG_STATUS}.tmp" 2>/dev/null && mv "${CG_STATUS}.tmp" "$CG_STATUS" 2>/dev/null
}

# Raise one finding: an event every time; a warning also alerts, at most once per CG_ALERT_GAP_SECS.
_cg_finding() {
    local msg="$1" sev="${2:-warning}" now ch
    _cg_last_finding="$msg"
    append_event "suspicious_cell" "$msg" "$sev"
    [ "$sev" = "warning" ] || return 0
    now=$(_cg_up)
    case "$now" in ''|*[!0-9]*) now=0 ;; esac
    if [ $((now - _cg_last_alert_up)) -lt "$CG_ALERT_GAP_SECS" ]; then
        _cg_suppressed=$((_cg_suppressed + 1))
        return 0
    fi
    if [ "$_cg_suppressed" -gt 0 ]; then
        msg="$msg (+${_cg_suppressed} more since the last alert)"
        _cg_suppressed=0
    fi
    _cg_last_alert_up="$now"
    command -v _ae_effective_send >/dev/null 2>&1 || return 0
    for ch in sms email telegram discord; do
        _ae_effective_send suspicious_cell "$ch" && _ae_dispatch "$ch" suspicious_cell "Suspicious cell: $msg"
    done
    return 0
}

_cg_known_get() { grep -m1 "^$1|" "$CG_KNOWN" 2>/dev/null; }

_cg_known_put() {
    local key="$1" line="$2" tmp
    tmp="${CG_KNOWN}.tmp.$$"
    { grep -v "^$key|" "$CG_KNOWN" 2>/dev/null; printf '%s\n' "$line"; } | tail -n "$CG_MAX_KNOWN" > "$tmp" 2>/dev/null \
        && mv "$tmp" "$CG_KNOWN" 2>/dev/null
    rm -f "$tmp" 2>/dev/null
}

# _cg_check_cell — compare the serving cell against what this location has seen before.
_cg_check_cell() {
    local radio id cid tac pci arfcn sig key prev mcc mnc label learning=0
    if [ "$network_type" = "5G-SA" ] && [ -n "$nr_cell_id" ]; then
        radio=N; cid="$nr_cell_id"; id="$nr_enodeb_id"; tac="$nr_tac"; pci="$nr_pci"; arfcn="$nr_arfcn"; label="gNB"
    elif [ -n "$lte_cell_id" ]; then
        radio=L; cid="$lte_cell_id"; id="$lte_enodeb_id"; tac="$lte_tac"; pci="$lte_pci"; arfcn="$lte_earfcn"; label="eNB"
    else
        return 0
    fi
    case "$cid$id" in *[!0-9]*|'') return 0 ;; esac

    sig="$radio|$cid|$tac|$pci|$arfcn"
    [ "$sig" = "$_cg_last_sig" ] && return 0
    _cg_last_sig="$sig"

    mcc=$(printf '%s' "${boot_imsi:-}" | cut -c1-3)
    mnc=$(printf '%s' "${boot_imsi:-}" | cut -c4-5 | sed 's/^0*//')
    [ -n "$mnc" ] || mnc=0
    key="$radio|$cid"
    _cg_learning && learning=1
    prev=$(_cg_known_get "$key")

    if [ -z "$prev" ]; then
        _cg_known_put "$key" "$key|$tac|$pci|$arfcn|$(date +%s)"
        [ "$learning" = "1" ] && return 0
        case "$mcc" in [0-9][0-9][0-9]) ;; *) return 0 ;; esac
        _cg_in_db "$mcc" "$mnc" "$radio" "$id"
        case $? in
            0) append_event "new_cell" "New cell $label $id (PCI $pci, TAC $tac)" "info" ;;
            1) _cg_finding "$label $id (PCI $pci, TAC $tac) was never seen here and is not in the tower database" ;;
            *) append_event "new_cell" "New cell $label $id (PCI $pci, TAC $tac)" "info" ;;
        esac
        _cg_check_distance "$mcc" "$mnc" "$radio" "$id" "$label"
        return 0
    fi

    # Known cell: a real cell keeps its TAC, PCI and channel.
    local ptac ppci parfcn
    ptac=$(printf '%s' "$prev" | cut -d'|' -f3)
    ppci=$(printf '%s' "$prev" | cut -d'|' -f4)
    parfcn=$(printf '%s' "$prev" | cut -d'|' -f5)
    _cg_known_put "$key" "$key|$tac|$pci|$arfcn|$(printf '%s' "$prev" | cut -d'|' -f6)"
    if [ -n "$ptac" ] && [ -n "$tac" ] && [ "$ptac" != "$tac" ]; then
        _cg_finding "$label $id now reports TAC $tac (it was $ptac)"
    elif [ -n "$ppci" ] && [ -n "$pci" ] && [ "$ppci" != "$pci" ]; then
        _cg_finding "$label $id cell $cid now uses PCI $pci (it was $ppci)" "info"
    elif [ -n "$parfcn" ] && [ -n "$arfcn" ] && [ "$parfcn" != "$arfcn" ]; then
        _cg_finding "$label $id cell $cid moved to channel $arfcn (it was $parfcn)" "info"
    fi
    [ "$learning" = "1" ] || _cg_check_distance "$mcc" "$mnc" "$radio" "$id" "$label"
}

# A fake station is usually close: timing advance near zero while the real tower is far away.
_cg_check_distance() {
    local home pos dist ta
    [ "$3" = "L" ] || return 0
    ta="${lte_ta:-}"
    case "$ta" in ''|*[!0-9]*) return 0 ;; esac
    home=$(_cg_home); [ -n "$home" ] || return 0
    pos=$(_cg_tower_pos "$1" "$2" "$3" "$4"); [ -n "$pos" ] || return 0
    dist=$(_cg_dist "$home" "$pos")
    case "$dist" in ''|*[!0-9]*) return 0 ;; esac
    if [ "$ta" -le 2 ] && [ "$dist" -gt 1500 ]; then
        _cg_finding "$5 $4 is about $((dist / 100))00 m away, but timing advance $ta puts the transmitter within 160 m"
    fi
}

# 2G/3G is where an IMSI catcher can run without mutual authentication.
_cg_check_rat() {
    local rat="${cg_legacy_rat:-}"
    [ "$rat" = "$_cg_last_rat" ] && return 0
    _cg_last_rat="$rat"
    [ -n "$rat" ] && _cg_finding "The modem dropped to $rat. Lithuanian 3G networks are shut down, so this is unusual"
    return 0
}

# Rayhunter (EFF) analyses signalling; new Medium/High warnings in the live recording become findings.
_cg_check_rayhunter() {
    [ "$_cg_rayhunter" = "true" ] || return 0
    _cg_rh_tick=$((_cg_rh_tick + 1))
    [ $((_cg_rh_tick % 30)) -eq 1 ] || return 0
    # Rayhunter listens on every interface; keep its port closed to all but loopback.
    [ -x /usr/bin/qmanager_rayhunter_mgr ] && /usr/bin/qmanager_rayhunter_mgr firewall-on >/dev/null 2>&1
    local log=/tmp/qmanager_rayhunter.log sz=0
    [ -f "$log" ] && sz=$(wc -c < "$log" 2>/dev/null)
    case "$sz" in ''|*[!0-9]*) sz=0 ;; esac
    if [ "$sz" -gt 1048576 ]; then
        tail -c 262144 "$log" > "$log.tmp" 2>/dev/null && cat "$log.tmp" > "$log" 2>/dev/null
        rm -f "$log.tmp"
    fi
    command -v curl >/dev/null 2>&1 || return 0
    local man name report n msg
    man=$(curl -s --max-time 3 "$CG_RAYHUNTER_URL/api/qmdl-manifest" 2>/dev/null) || return 0
    name=$(printf '%s' "$man" | jq -r '.current_entry.name // empty' 2>/dev/null)
    [ -n "$name" ] || return 0
    if [ "$name" != "$_cg_rh_entry" ]; then
        _cg_rh_entry="$name"
        _cg_rh_seen=0
    fi
    report=$(curl -s --max-time 5 "$CG_RAYHUNTER_URL/api/analysis-report/live" 2>/dev/null) || return 0
    n=$(printf '%s\n' "$report" | jq -R -s -r '
        [split("\n")[] | fromjson? | select(type == "object") | (.events // [])[]
         | select(. != null and (.event_type == "Medium" or .event_type == "High"))] | length' 2>/dev/null)
    case "$n" in ''|*[!0-9]*) return 0 ;; esac
    if [ "$n" -gt "$_cg_rh_seen" ]; then
        msg=$(printf '%s\n' "$report" | jq -R -s -r '
            [split("\n")[] | fromjson? | select(type == "object") | (.events // [])[]
             | select(. != null and (.event_type == "Medium" or .event_type == "High"))] | last | "\(.event_type): \(.message)"' 2>/dev/null)
        _cg_rh_seen="$n"
        _cg_finding "Rayhunter $msg"
    fi
}

# Called once per poll cycle, after detect_events.
cell_guard_check() {
    if [ "$_cg_cfg_loaded" != "1" ] || [ -f "$CG_RELOAD_FLAG" ]; then
        rm -f "$CG_RELOAD_FLAG" 2>/dev/null
        cg_load_config || return 0
    fi
    [ "$_cg_enabled" = "true" ] || return 0
    [ "${modem_reachable:-}" = "true" ] || return 0
    local before="$_cg_last_sig$_cg_last_rat$_cg_rh_seen"
    _cg_check_rat
    _cg_check_cell
    _cg_check_rayhunter
    if [ "$before" != "$_cg_last_sig$_cg_last_rat$_cg_rh_seen" ] || [ ! -f "$CG_STATUS" ] \
        || [ $((${cycle_count:-0} % 150)) -eq 0 ]; then
        _cg_status_write
    fi
}

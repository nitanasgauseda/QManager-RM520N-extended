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
: "${CG_SMS_SEEN:=/etc/qmanager/cell_guard_sms_seen}"
CG_SMS_EVERY=300
CG_RELOAD_FLAG="/tmp/qmanager_cell_guard_reload"
CG_MAX_KNOWN=3000
CG_ALERT_GAP_SECS=600
CG_SANE_EPOCH=1700000000

# qm_replace <dest> — stdin replaces <dest> atomically. The temp name comes from mktemp, so a
# symlink planted at a guessable "<dest>.tmp" is never followed (root writes these files, some in
# www-data's /etc/qmanager). Empty input leaves <dest> alone; 0644 so the CGIs can still read it.
command -v qm_replace >/dev/null 2>&1 || qm_replace() {
    local t
    t=$(mktemp "$1.XXXXXX" 2>/dev/null) || return 1
    if cat > "$t" && [ -s "$t" ] && chmod 644 "$t" && mv -f "$t" "$1"; then return 0; fi
    rm -f "$t"
    return 1
}

_cg_enabled="true"
_cg_learn_hours=24
_cg_rayhunter="false"
_cg_sms="true"
_cg_sms_next=0
_cg_jam="true"
_cg_jam_next=0
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
        _cg_sms=$(jq -r 'if .sms_guard == false then "false" else "true" end' "$CG_CONFIG" 2>/dev/null)
        _cg_jam=$(jq -r 'if .jam_guard == false then "false" else "true" end' "$CG_CONFIG" 2>/dev/null)
    fi
    case "$_cg_sms" in true|false) ;; *) _cg_sms="true" ;; esac
    case "$_cg_jam" in true|false) ;; *) _cg_jam="true" ;; esac
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
        2>/dev/null | qm_replace "$CG_STATUS"
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
    { grep -v "^$1|" "$CG_KNOWN" 2>/dev/null; printf '%s\n' "$2"; } | tail -n "$CG_MAX_KNOWN" | qm_replace "$CG_KNOWN"
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
    local line
    line="$key|$tac|$pci|$arfcn|$(printf '%s' "$prev" | cut -d'|' -f6)"
    # Hopping between two known cells must not rewrite the file on flash each time.
    [ "$line" = "$prev" ] || _cg_known_put "$key" "$line"
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
        # Copied back into the same inode: the service keeps appending to its open file.
        local t
        if [ ! -L "$log" ] && t=$(mktemp "$log.XXXXXX" 2>/dev/null); then
            tail -c 262144 "$log" > "$t" 2>/dev/null && cat "$t" > "$log" 2>/dev/null
            rm -f "$t"
        fi
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

# _cg_sms_classify — read +CMGL (PDU mode) output on stdin; print "reasons|sender|pdu" for
# SMS-DELIVER messages whose header marks them as silent, flash, SIM-directed or binary pushes.
# BusyBox 1.31 awk reads "NAME (" as a function call: never put a variable before "(".
_cg_sms_classify() {
    awk '
        function hx(s,   i, v, c) {
            v = 0
            for (i = 1; i <= length(s); i++) {
                c = index("0123456789ABCDEF", substr(s, i, 1)) - 1
                if (c < 0) return -1
                v = v * 16 + c
            }
            return v
        }
        function classify(p,   pos, sl, fo, udhi, oal, toa, oct, oa, sender, i, pid, dcs, udl, r, cls, udhl, j, end, iei, iel, port, wsp, ct) {
            sl = hx(substr(p, 1, 2))
            pos = 3 + sl * 2
            fo = hx(substr(p, pos, 2)); pos += 2
            if (fo < 0 || fo % 4 != 0) return
            udhi = int(fo / 64) % 2
            oal = hx(substr(p, pos, 2)); pos += 2
            toa = hx(substr(p, pos, 2)); pos += 2
            oct = int((oal + 1) / 2)
            oa = substr(p, pos, oct * 2); pos += oct * 2
            if (int(toa / 16) % 8 == 5) {
                sender = "alphanumeric sender"
            } else {
                sender = ""
                for (i = 1; i < length(oa); i += 2) sender = sender substr(oa, i + 1, 1) substr(oa, i, 1)
                sub(/F$/, "", sender)
                if (int(toa / 16) % 8 == 1) sender = "+" sender
            }
            pid = hx(substr(p, pos, 2)); pos += 2
            dcs = hx(substr(p, pos, 2)); pos += 2
            pos += 14
            udl = hx(substr(p, pos, 2)); pos += 2
            if (pid < 0 || dcs < 0 || udl < 0) return
            r = ""
            if (pid == 64) r = r ",type0"
            else if (pid >= 65 && pid <= 71) r = r ",replace"
            else if (pid == 127) r = r ",sim_download"
            cls = -1
            if (int(dcs / 64) == 0 && int(dcs / 16) % 2 == 1) cls = dcs % 4
            if (int(dcs / 16) == 15) cls = dcs % 4
            if (cls == 0) r = r ",flash"
            if (udl == 0) r = r ",empty"
            if (udhi) {
                udhl = hx(substr(p, pos, 2))
                j = pos + 2
                end = j + udhl * 2
                while (udhl > 0 && j < end) {
                    iei = hx(substr(p, j, 2)); iel = hx(substr(p, j + 2, 2))
                    if (iel < 0) break
                    port = -1
                    if (iei == 5) port = hx(substr(p, j + 4, 4))
                    if (iei == 4) port = hx(substr(p, j + 4, 2))
                    if (port == 2948 || port == 2949) {
                        # WAP push: MMS notifications (content type 0x3E) are normal; anything else is a config push.
                        wsp = end
                        ct = hx(substr(p, wsp + 6, 2))
                        if (ct != 190) r = r ",wap_push"
                    } else if (port >= 0) {
                        r = r ",port" port
                    }
                    j += 4 + iel * 2
                }
            }
            if (r != "") print substr(r, 2) "|" sender "|" p
        }
        { sub(/\r$/, "") }
        /^\+CMGL:/ { want = 1; next }
        want && $0 ~ /^[0-9A-Fa-f]+$/ { want = 0; classify(toupper($0)); next }
        { want = 0 }'
}

_cg_sms_reason_text() {
    case "$1" in
        type0*) printf 'a silent SMS (type 0), which phones never show and which can be used to locate a device' ;;
        *sim_download*) printf 'a message addressed to the SIM card itself (SIM data download)' ;;
        *wap_push*) printf 'a configuration push message' ;;
        *replace*) printf 'a replace-type SMS that overwrites an earlier message' ;;
        *flash*) printf 'a flash SMS (shown once, not stored)' ;;
        *port*) printf 'a binary SMS to application port %s' "$(printf '%s' "$1" | sed 's/.*port\([0-9]*\).*/\1/')" ;;
        *empty*) printf 'an empty SMS' ;;
        *) printf 'an unusual SMS' ;;
    esac
}

# Every CG_SMS_EVERY seconds: list stored SMS in PDU mode and report new suspicious ones once.
_cg_check_sms() {
    [ "$_cg_sms" = "true" ] || return 0
    local up out line reasons sender pdu key sev list
    up=$(_cg_up)
    case "$up" in ''|*[!0-9]*) return 0 ;; esac
    [ "$up" -ge "$_cg_sms_next" ] || return 0
    _cg_sms_next=$((up + CG_SMS_EVERY))
    command -v qcmd >/dev/null 2>&1 || return 0
    # One compound command: nothing can switch the SMS mode back to text between the two.
    out=$(qcmd 'AT+CMGF=0;+CMGL=4' 2>/dev/null) || return 0
    # Root writes here: a mktemp name, never a guessable /tmp path a symlink could be planted on.
    list=$(mktemp /tmp/qmanager_cg_sms.XXXXXX 2>/dev/null) || return 0
    printf '%s\n' "$out" | _cg_sms_classify > "$list" 2>/dev/null
    while IFS='|' read -r reasons sender pdu; do
        [ -n "$pdu" ] || continue
        key=$(printf '%s' "$pdu" | md5sum 2>/dev/null | cut -c1-16)
        grep -qxF "$key" "$CG_SMS_SEEN" 2>/dev/null && continue
        printf '%s\n' "$key" >> "$CG_SMS_SEEN" 2>/dev/null
        sev=warning
        case "$reasons" in type0*|*sim_download*|*wap_push*) ;; *) sev=info ;; esac
        _cg_sms_finding "Suspicious SMS from ${sender:-an unknown sender}: $(_cg_sms_reason_text "$reasons")" "$sev"
    done < "$list"
    rm -f "$list"
    if [ -f "$CG_SMS_SEEN" ] && [ "$(wc -l < "$CG_SMS_SEEN")" -gt 300 ]; then
        tail -n 200 "$CG_SMS_SEEN" 2>/dev/null | qm_replace "$CG_SMS_SEEN"
    fi
    return 0
}

# --- Jamming: signal quality collapses while signal strength stays put --------------------------
# Per radio, against a slow average for the serving cell; thresholds and the recovery rule are in
# docs/reference/cell-guard.md.
CG_JAM_EVERY=10
CG_JAM_LEARN=30
CG_JAM_STREAK=18
CG_JAM_DROP=10
CG_JAM_RSRP=4

# _cg_int <value> — whole dB from "-12", "7.5" or "-3.2"; empty when not a number.
_cg_int() {
    local v="${1%%.*}"
    case "${v#-}" in ''|*[!0-9]*) return 0 ;; esac
    printf '%s' "$v"
}

_cg_jam_one() {
    local r="$1" label="$2" cell="$3" q p rs n bad alarm good q10 p10 r10 dq dp msg
    q=$(_cg_int "$4"); p=$(_cg_int "$5"); rs=$(_cg_int "$6")
    eval "n=\${_cg_j${r}_n:-0} bad=\${_cg_j${r}_bad:-0} alarm=\${_cg_j${r}_alarm:-0} good=\${_cg_j${r}_good:-0}"
    eval "q10=\${_cg_j${r}_q10:-} p10=\${_cg_j${r}_p10:-} r10=\${_cg_j${r}_r10:-}"
    if [ -z "$cell" ] || [ -z "$q" ] || [ -z "$p" ]; then
        return 0
    fi
    if [ "$cell" != "$(eval "printf '%s' \"\${_cg_j${r}_cell:-}\"")" ]; then
        eval "_cg_j${r}_cell=\$cell"
        n=0; bad=0; alarm=0; good=0; q10=$((q * 10)); p10=$((p * 10)); r10=""
        [ -n "$rs" ] && r10=$((rs * 10))
    fi
    if [ "$n" -lt "$CG_JAM_LEARN" ]; then
        n=$((n + 1))
        q10=$((q10 + (q * 10 - q10) / 4)); p10=$((p10 + (p * 10 - p10) / 4))
        if [ -n "$rs" ]; then r10=$(( ${r10:-$((rs * 10))} + (rs * 10 - ${r10:-$((rs * 10))}) / 4 )); fi
    else
        dq=$(( (q10 - q * 10) / 10 )); dp=$(( (p10 - p * 10) / 10 ))
        if [ "$dq" -ge "$CG_JAM_DROP" ] && [ "$dp" -le "$CG_JAM_RSRP" ]; then
            bad=$((bad + 1)); good=0
            if [ "$alarm" = "0" ] && [ "$bad" -ge "$CG_JAM_STREAK" ]; then
                alarm=1
                msg="Possible jamming on $label cell $cell: signal quality fell from $((q10 / 10)) to $q dB SINR for $((CG_JAM_STREAK * CG_JAM_EVERY / 60)) minutes while signal strength stayed at $p dBm"
                if [ -n "$rs" ] && [ -n "$r10" ] && [ $((rs - r10 / 10)) -ge 3 ]; then
                    msg="$msg and the received power rose by $((rs - r10 / 10)) dB"
                fi
                _cg_finding "$msg"
            fi
        else
            bad=0
            if [ "$alarm" = "1" ]; then
                if [ "$dq" -le 5 ]; then good=$((good + 1)); else good=0; fi
                if [ "$good" -ge 6 ]; then
                    alarm=0; good=0
                    _cg_finding "Signal quality on $label cell $cell is back to normal ($q dB SINR)" "info"
                fi
            else
                # The average follows slow, real changes (weather, foliage) but not a sudden collapse.
                q10=$((q10 + (q * 10 - q10) / 32)); p10=$((p10 + (p * 10 - p10) / 32))
                if [ -n "$rs" ]; then r10=$(( ${r10:-$((rs * 10))} + (rs * 10 - ${r10:-$((rs * 10))}) / 32 )); fi
            fi
        fi
    fi
    eval "_cg_j${r}_n=\$n _cg_j${r}_bad=\$bad _cg_j${r}_alarm=\$alarm _cg_j${r}_good=\$good"
    eval "_cg_j${r}_q10=\$q10 _cg_j${r}_p10=\$p10 _cg_j${r}_r10=\$r10"
}

_cg_check_jam() {
    local up
    [ "$_cg_jam" = "true" ] || return 0
    up=$(_cg_up)
    case "$up" in ''|*[!0-9]*) return 0 ;; esac
    [ "$up" -ge "$_cg_jam_next" ] || return 0
    _cg_jam_next=$((up + CG_JAM_EVERY))
    case "${lte_cell_id:-}" in ''|*[!0-9]*) ;; *)
        _cg_jam_one L LTE "${lte_enodeb_id:-?}/$lte_cell_id" "${lte_sinr:-}" "${lte_rsrp:-}" "${lte_rssi:-}" ;;
    esac
    case "${nr_pci:-}" in ''|*[!0-9]*) ;; *)
        _cg_jam_one N 5G "PCI $nr_pci" "${nr_sinr:-}" "${nr_rsrp:-}" "" ;;
    esac
    return 0
}

# SMS findings are their own event type; warnings alert through the Cell Guard routing.
# A flood of silent SMS logs every one but alerts at most once per CG_ALERT_GAP_SECS.
_cg_sms_alert_up=-100000
_cg_sms_finding() {
    local now ch
    append_event "suspicious_sms" "$1" "$2"
    _cg_last_finding="$1"
    [ "$2" = "warning" ] || return 0
    now=$(_cg_up)
    case "$now" in ''|*[!0-9]*) now=0 ;; esac
    [ $((now - _cg_sms_alert_up)) -ge "$CG_ALERT_GAP_SECS" ] || return 0
    _cg_sms_alert_up="$now"
    command -v _ae_effective_send >/dev/null 2>&1 || return 0
    for ch in sms email telegram discord; do
        _ae_effective_send suspicious_cell "$ch" && _ae_dispatch "$ch" suspicious_cell "$1"
    done
    return 0
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
    _cg_check_sms
    _cg_check_jam
    if [ "$before" != "$_cg_last_sig$_cg_last_rat$_cg_rh_seen" ] || [ ! -f "$CG_STATUS" ] \
        || [ $((${cycle_count:-0} % 150)) -eq 0 ]; then
        _cg_status_write
    fi
}

#!/bin/bash
# insights.sh — long-term signal history, data-plan limit and temperature alerts.
# Sourced by qmanager_poller (bash: byte counters need 64-bit arithmetic); insights_check runs every cycle.
# See docs/reference/insights.md.

[ -n "${_INSIGHTS_LOADED:-}" ] && return 0
_INSIGHTS_LOADED=1

: "${IN_CONFIG:=/etc/qmanager/insights.json}"
: "${IN_STATE:=/etc/qmanager/insights_state.json}"
: "${IN_STATUS:=/tmp/qmanager_insights.json}"
: "${IN_BUF:=/tmp/qmanager_sighist_buf.csv}"
: "${IN_HIST_DIR:=/usrdata/qmanager/sighist}"
IN_RELOAD_FLAG="/tmp/qmanager_insights_reload"
IN_SANE_EPOCH=1700000000
IN_FLUSH_LINES=15
IN_MIN_FREE_KB=20480

_in_loaded=0
_in_hist_enabled=true
_in_hist_days=30
_in_dl_enabled=false
_in_dl_limit_gb=0
_in_dl_day=1
_in_dl_warn=80
_in_dl_set_at=0
_in_dl_used_mb=0
_in_temp_enabled=true
_in_temp_alert=75

# Minute accumulator (integers only).
_in_next_min=0
_in_n_l=0; _in_s_lrsrp=0; _in_s_lrsrq=0; _in_s_lsinr=0
_in_n_n=0; _in_s_nrsrp=0; _in_s_nsinr=0
_in_prev_rx=""; _in_prev_tx=""

# Persistent state, mirrored in memory.
_in_cycle_start=0
_in_cycle_base=0
_in_warned=0
_in_state_set_at=0
_in_temp_high=0
_in_temp_streak=0
_in_last_temp=""

_in_up() { awk '{ print int($1) }' /proc/uptime 2>/dev/null; }
_in_int() { case "$1" in ''|-|*[!0-9-]*|-*-*|?*-*) return 1 ;; esac; return 0; }

insights_load_config() {
    command -v jq >/dev/null 2>&1 || return 1
    local row=""
    [ -f "$IN_CONFIG" ] && row=$(jq -r '[
        (if .history.enabled == false then "false" else "true" end),
        (.history.days // 30),
        (if .data_limit.enabled == true then "true" else "false" end),
        (.data_limit.limit_gb // 0), (.data_limit.billing_day // 1), (.data_limit.warn_pct // 80),
        (.data_limit.set_at // 0), (.data_limit.used_mb // 0),
        (if .temperature.enabled == false then "false" else "true" end),
        (.temperature.alert_c // 75)
      ] | map(tostring) | join(" ")' "$IN_CONFIG" 2>/dev/null)
    if [ -n "$row" ]; then
        # shellcheck disable=SC2086
        set -- $row
        _in_hist_enabled="$1"; _in_hist_days="$2"; _in_dl_enabled="$3"; _in_dl_limit_gb="$4"
        _in_dl_day="$5"; _in_dl_warn="$6"; _in_dl_set_at="$7"; _in_dl_used_mb="$8"
        _in_temp_enabled="$9"; _in_temp_alert="${10}"
    fi
    _in_int "$_in_hist_days" || _in_hist_days=30
    _in_int "$_in_dl_limit_gb" || _in_dl_limit_gb=0
    _in_int "$_in_dl_day" || _in_dl_day=1
    { [ "$_in_dl_day" -ge 1 ] && [ "$_in_dl_day" -le 28 ]; } || _in_dl_day=1
    _in_int "$_in_dl_warn" || _in_dl_warn=80
    _in_int "$_in_dl_set_at" || _in_dl_set_at=0
    _in_int "$_in_dl_used_mb" || _in_dl_used_mb=0
    _in_int "$_in_temp_alert" || _in_temp_alert=75

    if [ -f "$IN_STATE" ]; then
        row=$(jq -r '[(.cycle_start // 0), (.cycle_base // 0), (.warned // 0), (.set_at // 0), (.temp_high // 0)]
            | map(tostring) | join(" ")' "$IN_STATE" 2>/dev/null)
        if [ -n "$row" ]; then
            # shellcheck disable=SC2086
            set -- $row
            _in_cycle_start="$1"; _in_cycle_base="$2"; _in_warned="$3"; _in_state_set_at="$4"; _in_temp_high="$5"
        fi
    fi
    _in_loaded=1
}

_in_save_state() {
    printf '{"cycle_start":%s,"cycle_base":%s,"warned":%s,"set_at":%s,"temp_high":%s}\n' \
        "$_in_cycle_start" "$_in_cycle_base" "$_in_warned" "$_in_state_set_at" "$_in_temp_high" \
        > "${IN_STATE}.tmp" 2>/dev/null && mv "${IN_STATE}.tmp" "$IN_STATE" 2>/dev/null
}

# Send an alert event through the alert engine's routing (if it is loaded).
_in_alert() {
    local event="$1" msg="$2" ch
    command -v _ae_effective_send >/dev/null 2>&1 || return 0
    for ch in sms email telegram discord; do
        _ae_effective_send "$event" "$ch" && _ae_dispatch "$ch" "$event" "$msg"
    done
    return 0
}

# Local midnight epoch of the most recent billing day at or before now, and the next one.
_in_cycle_bounds() {
    local y m d day=$_in_dl_day py pm ny nm
    y=$(date +%Y); m=$(date +%m); d=$(date +%d)
    m=$((10#$m)); d=$((10#$d))
    if [ "$d" -ge "$day" ]; then
        py=$y; pm=$m
    elif [ "$m" -eq 1 ]; then
        py=$((y - 1)); pm=12
    else
        py=$y; pm=$((m - 1))
    fi
    if [ "$pm" -eq 12 ]; then ny=$((py + 1)); nm=1; else ny=$py; nm=$((pm + 1)); fi
    IN_CYCLE_START=$(date -d "$(printf '%04d-%02d-%02d 00:00:00' "$py" "$pm" "$day")" +%s 2>/dev/null)
    IN_CYCLE_NEXT=$(date -d "$(printf '%04d-%02d-%02d 00:00:00' "$ny" "$nm" "$day")" +%s 2>/dev/null)
    _in_int "$IN_CYCLE_START" && _in_int "$IN_CYCLE_NEXT"
}

_in_check_data_limit() {
    local total used limit pct changed=0 now
    [ "$_in_dl_enabled" = "true" ] || return 0
    [ "$_in_dl_limit_gb" -gt 0 ] 2>/dev/null || return 0
    total=$(( ${du_accumulated_rx:-0} + ${du_accumulated_tx:-0} ))
    _in_cycle_bounds || return 0

    if [ "$_in_cycle_start" != "$IN_CYCLE_START" ]; then
        [ "$_in_cycle_start" -gt 0 ] 2>/dev/null && append_event "data_limit" "New billing cycle started" "info"
        _in_cycle_start="$IN_CYCLE_START"; _in_cycle_base="$total"; _in_warned=0; changed=1
    fi
    # A user-entered "used so far" re-anchors the cycle.
    if [ "$_in_dl_set_at" != "$_in_state_set_at" ]; then
        _in_cycle_base=$(( total - _in_dl_used_mb * 1048576 ))
        _in_state_set_at="$_in_dl_set_at"; _in_warned=0; changed=1
    fi
    # The usage counter was reset under us (Data Used reset): keep this cycle's usage continuous.
    if [ -n "${_in_last_total:-}" ] && [ "$total" -lt "$_in_last_total" ]; then
        _in_cycle_base=$(( total - ${_in_last_used:-0} )); changed=1
    elif [ "$total" -lt "$_in_cycle_base" ] && [ "$_in_cycle_base" -gt 0 ]; then
        _in_cycle_base=0; changed=1
    fi
    _in_last_total="$total"

    used=$(( total - _in_cycle_base ))
    [ "$used" -lt 0 ] && used=0
    _in_last_used="$used"
    limit=$(( _in_dl_limit_gb * 1073741824 ))
    pct=$(( used * 100 / limit ))

    if [ "$pct" -ge 100 ] && [ "$_in_warned" -lt 100 ]; then
        _in_warned=100; changed=1
        append_event "data_limit" "Data plan used up: $((used / 1048576)) MB of ${_in_dl_limit_gb} GB" "warning"
        _in_alert data_limit "Data plan used up: $((used / 1048576)) MB of ${_in_dl_limit_gb} GB"
    elif [ "$pct" -ge "$_in_dl_warn" ] && [ "$_in_warned" -lt "$_in_dl_warn" ]; then
        _in_warned="$_in_dl_warn"; changed=1
        append_event "data_limit" "${pct}% of the data plan used ($((used / 1048576)) MB of ${_in_dl_limit_gb} GB)" "warning"
        _in_alert data_limit "${pct}% of the data plan used ($((used / 1048576)) MB of ${_in_dl_limit_gb} GB)"
    fi
    [ "$changed" = "1" ] && _in_save_state
    IN_USED="$used"; IN_LIMIT="$limit"; IN_PCT="$pct"
    now=$(date +%s)
    IN_DAYS_LEFT=$(( (IN_CYCLE_NEXT - now + 86399) / 86400 ))
}

# Two consecutive readings at or above the threshold raise; dropping 5 °C below clears.
_in_check_temp() {
    local t="${t2_temperature:-}"
    [ "$_in_temp_enabled" = "true" ] || return 0
    _in_int "$t" || return 0
    [ "$t" = "$_in_last_temp" ] && [ "$_in_temp_streak" -ge 2 ] && return 0
    _in_last_temp="$t"
    if [ "$t" -ge "$_in_temp_alert" ]; then
        _in_temp_streak=$((_in_temp_streak + 1))
        if [ "$_in_temp_streak" -ge 2 ] && [ "$_in_temp_high" != "1" ]; then
            _in_temp_high=1; _in_save_state
            append_event "temperature_high" "Modem temperature ${t} °C (alert at ${_in_temp_alert} °C)" "warning"
            _in_alert temperature "Modem temperature is ${t} °C (alert at ${_in_temp_alert} °C)"
        fi
    else
        _in_temp_streak=0
        if [ "$_in_temp_high" = "1" ] && [ "$t" -le $((_in_temp_alert - 5)) ]; then
            _in_temp_high=0; _in_save_state
            append_event "temperature_normal" "Modem temperature back to ${t} °C" "info"
        fi
    fi
}

_in_accumulate() {
    if _in_int "${lte_rsrp:-}" && _in_int "${lte_sinr:-}"; then
        _in_n_l=$((_in_n_l + 1))
        _in_s_lrsrp=$((_in_s_lrsrp + lte_rsrp)); _in_s_lsinr=$((_in_s_lsinr + lte_sinr))
        _in_int "${lte_rsrq:-}" && _in_s_lrsrq=$((_in_s_lrsrq + lte_rsrq))
    fi
    if _in_int "${nr_rsrp:-}" && _in_int "${nr_sinr:-}"; then
        _in_n_n=$((_in_n_n + 1))
        _in_s_nrsrp=$((_in_s_nrsrp + nr_rsrp)); _in_s_nsinr=$((_in_s_nsinr + nr_sinr))
    fi
}

_in_avg() { [ "$2" -gt 0 ] && printf '%s' $(( $1 / $2 )); }

# One CSV line per minute: ts,net,lband,lpci,lenb,lrsrp,lrsrq,lsinr,nband,npci,nrsrp,nsinr,temp,rx,tx
_in_write_minute() {
    local now rx tx drx="" dtx=""
    now=$(date +%s)
    rx="${du_accumulated_rx:-0}"; tx="${du_accumulated_tx:-0}"
    if [ -n "$_in_prev_rx" ] && [ "$rx" -ge "$_in_prev_rx" ] && [ "$tx" -ge "$_in_prev_tx" ]; then
        drx=$((rx - _in_prev_rx)); dtx=$((tx - _in_prev_tx))
    fi
    _in_prev_rx="$rx"; _in_prev_tx="$tx"
    if [ "$_in_hist_enabled" = "true" ] && [ "$now" -ge "$IN_SANE_EPOCH" ] && { [ "$_in_n_l" -gt 0 ] || [ "$_in_n_n" -gt 0 ]; }; then
        local lq=""
        [ "$_in_n_l" -gt 0 ] && lq=$(( _in_s_lrsrq / _in_n_l ))
        printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
            "$now" "${network_type:-}" "${lte_band:-}" "${lte_pci:-}" "${lte_enodeb_id:-}" \
            "$(_in_avg "$_in_s_lrsrp" "$_in_n_l")" "$lq" "$(_in_avg "$_in_s_lsinr" "$_in_n_l")" \
            "${nr_band:-}" "${nr_pci:-}" "$(_in_avg "$_in_s_nrsrp" "$_in_n_n")" "$(_in_avg "$_in_s_nsinr" "$_in_n_n")" \
            "${t2_temperature:-}" "$drx" "$dtx" | tr -d ' ' >> "$IN_BUF" 2>/dev/null
    fi
    _in_n_l=0; _in_s_lrsrp=0; _in_s_lrsrq=0; _in_s_lsinr=0
    _in_n_n=0; _in_s_nrsrp=0; _in_s_nsinr=0
}

# Move the RAM buffer to flash in one write, one file per UTC day; prune old days.
insights_flush() {
    local lines free today f day
    [ -s "$IN_BUF" ] || return 0
    lines=$(wc -l < "$IN_BUF" 2>/dev/null)
    [ "${1:-}" = "force" ] || [ "${lines:-0}" -ge "$IN_FLUSH_LINES" ] || return 0
    mkdir -p "$IN_HIST_DIR" 2>/dev/null || return 0
    free=$(df -k "$IN_HIST_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }')
    if _in_int "$free" && [ "$free" -lt "$IN_MIN_FREE_KB" ]; then
        qlog_warn "insights: /usrdata low on space (${free} KB), history not saved"
        : > "$IN_BUF"
        return 0
    fi
    awk -F, -v dir="$IN_HIST_DIR" '$1 ~ /^[0-9]+$/ { f = dir "/d" int($1 / 86400) ".csv"; print >> f } END { close(f) }' "$IN_BUF" \
        && : > "$IN_BUF"
    today=$(( $(date +%s) / 86400 ))
    for f in "$IN_HIST_DIR"/d*.csv; do
        [ -e "$f" ] || continue
        day="${f##*/d}"; day="${day%.csv}"
        _in_int "$day" || continue
        [ "$day" -lt $((today - _in_hist_days)) ] && rm -f "$f"
    done
    return 0
}

_in_write_status() {
    jq -n -c --argjson en "$([ "$_in_dl_enabled" = "true" ] && echo true || echo false)" \
        --arg used "${IN_USED:-}" --arg limit "${IN_LIMIT:-}" --arg pct "${IN_PCT:-}" \
        --arg start "${IN_CYCLE_START:-}" --arg next "${IN_CYCLE_NEXT:-}" --arg left "${IN_DAYS_LEFT:-}" \
        --arg temp "${t2_temperature:-}" --argjson hot "${_in_temp_high:-0}" --argjson ts "$(date +%s)" \
        '{updated: $ts,
          data_limit: {enabled: $en, used_bytes: ($used | tonumber? // null), limit_bytes: ($limit | tonumber? // null),
                       percent: ($pct | tonumber? // null), cycle_start: ($start | tonumber? // null),
                       cycle_next: ($next | tonumber? // null), days_left: ($left | tonumber? // null)},
          temperature: {current: ($temp | tonumber? // null), alerting: ($hot == 1)}}' \
        > "${IN_STATUS}.tmp" 2>/dev/null && mv "${IN_STATUS}.tmp" "$IN_STATUS" 2>/dev/null
}

insights_check() {
    if [ "$_in_loaded" != "1" ] || [ -f "$IN_RELOAD_FLAG" ]; then
        rm -f "$IN_RELOAD_FLAG" 2>/dev/null
        insights_load_config || return 0
    fi
    [ "${modem_reachable:-}" = "true" ] && _in_accumulate
    _in_check_temp

    local up
    up=$(_in_up); _in_int "$up" || return 0
    [ "$_in_next_min" -eq 0 ] && _in_next_min=$((up + 60))
    [ "$up" -ge "$_in_next_min" ] || return 0
    _in_next_min=$((up + 60))

    _in_write_minute
    IN_USED=""; IN_LIMIT=""; IN_PCT=""; IN_CYCLE_START=""; IN_CYCLE_NEXT=""; IN_DAYS_LEFT=""
    _in_check_data_limit
    _in_write_status
    insights_flush
}

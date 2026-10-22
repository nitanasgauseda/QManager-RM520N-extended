#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# cell_guard.sh — Cell Guard (fake base station detection) settings, findings and the optional Rayhunter daemon.
#   GET                       config, detector status, recent findings, Rayhunter state
#   POST save {enabled, learn_hours, sms_guard?} | reset_baseline
#   POST rayhunter_install | rayhunter_install_status | rayhunter_enable | rayhunter_disable | rayhunter_uninstall
# See docs/reference/cell-guard.md.

qlog_init "cgi_cell_guard"
cgi_headers
cgi_handle_options

CONF="${QM_CG_CONFIG:-/etc/qmanager/cell_guard.json}"
KNOWN="/etc/qmanager/cell_guard_known"
SINCE="/etc/qmanager/cell_guard_since"
STATUS="/tmp/qmanager_cell_guard.json"
EVENTS="/tmp/qmanager_events.json"
RELOAD="/tmp/qmanager_cell_guard_reload"
RH_DIR="/usrdata/rayhunter"
RH_URL="http://127.0.0.1:8686"
RH_LOG="/tmp/qmanager_rayhunter.log"
HELPER="/usr/bin/qmanager_rayhunter_mgr"

conf_json() {
    _c=""
    [ -f "$CONF" ] && _c=$(jq -c '.' "$CONF" 2>/dev/null)
    [ -n "$_c" ] || _c='{}'
    printf '%s' "$_c"
}

conf_merge() {
    _f="$1"; shift
    if ! conf_json | jq -c "$@" "$_f" > "${CONF}.tmp" 2>/dev/null; then
        rm -f "${CONF}.tmp"; return 1
    fi
    mv "${CONF}.tmp" "$CONF" && touch "$RELOAD" 2>/dev/null
}

helper() {
    HELPER_OUT=$($_SUDO "$HELPER" "$1" </dev/null 2>/dev/null)
}

helper_fail() {
    _e=$(printf '%s' "$HELPER_OUT" | jq -r '.error // "helper_failed"' 2>/dev/null)
    _d=$(printf '%s' "$HELPER_OUT" | jq -r '.detail // ""' 2>/dev/null)
    cgi_error "${_e:-helper_failed}" "${_d:-$1}"
}

if [ "$REQUEST_METHOD" = "GET" ]; then
    status='null'
    [ -s "$STATUS" ] && status=$(jq -c '.' "$STATUS" 2>/dev/null || printf 'null')
    findings='[]'
    if [ -s "$EVENTS" ]; then
        findings=$(jq -R -s -c '[split("\n")[] | fromjson? | select(type == "object")
            | select(.type == "suspicious_cell" or .type == "new_cell" or .type == "suspicious_sms")] | reverse | .[0:40]' "$EVENTS" 2>/dev/null)
        [ -n "$findings" ] || findings='[]'
    fi

    rh_installed=false; rh_version=""; rh_running=false; rh_diag=false
    [ -x "$RH_DIR/rayhunter-daemon" ] && rh_installed=true
    [ -f "$RH_DIR/VERSION" ] && rh_version=$(head -c 32 "$RH_DIR/VERSION" | tr -d '\r\n')
    [ -e /dev/diag ] && rh_diag=true
    [ "$(systemctl is-active qmanager-rayhunter 2>/dev/null)" = "active" ] && rh_running=true
    rh_install=$(helper install-status; printf '%s' "$HELPER_OUT")
    printf '%s' "$rh_install" | jq -e . >/dev/null 2>&1 || rh_install='{"status":"idle"}'
    rh_log=""
    [ -f "$RH_LOG" ] && rh_log=$(tail -n 12 "$RH_LOG" 2>/dev/null | cut -c1-300)
    rh_live='null'
    if [ "$rh_running" = "true" ] && command -v curl >/dev/null 2>&1; then
        _man=$(curl -s --max-time 3 "$RH_URL/api/qmdl-manifest" 2>/dev/null)
        _rep=$(curl -s --max-time 5 "$RH_URL/api/analysis-report/live" 2>/dev/null)
        rh_live=$(jq -n -c --arg man "$_man" --arg rep "$_rep" '
            ($man | fromjson? // {}) as $m
            | {recording: ($m.current_entry.name // null),
               started: ($m.current_entry.start_time // null),
               size_bytes: ($m.current_entry.qmdl_size_bytes // null),
               recordings: (($m.entries // []) | length),
               warnings: [($rep | split("\n"))[] | fromjson? | select(type == "object")
                          | . as $row | (.events // [])[]
                          | select(. != null and (.event_type == "Low" or .event_type == "Medium" or .event_type == "High"))
                          | {severity: .event_type, message: .message, at: ($row.packet_timestamp // null)}]
                         | reverse | .[0:20]}' 2>/dev/null)
        [ -n "$rh_live" ] || rh_live='null'
    fi

    jq -n --argjson c "$(conf_json)" --argjson status "$status" --argjson findings "$findings" \
        --argjson inst "$rh_installed" --arg ver "$rh_version" --argjson run "$rh_running" \
        --argjson diag "$rh_diag" --argjson install "$rh_install" --arg log "$rh_log" --argjson live "$rh_live" '{
        success: true,
        config: {
            enabled: ($c.enabled != false),
            learn_hours: ($c.learn_hours // 24),
            rayhunter: ($c.rayhunter == true),
            sms_guard: ($c.sms_guard != false)
        },
        status: $status,
        findings: $findings,
        rayhunter: {
            installed: $inst, version: $ver, running: $run, diag_present: $diag,
            install: $install, log: $log, live: $live
        }
    }'
    exit 0
fi

[ "$REQUEST_METHOD" = "POST" ] || { cgi_method_not_allowed; exit 0; }
cgi_read_post
ACTION=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)

case "$ACTION" in
    save)
        en=$(printf '%s' "$POST_DATA" | jq -r '.enabled | tostring' 2>/dev/null)
        lh=$(printf '%s' "$POST_DATA" | jq -r '.learn_hours // 24 | tostring' 2>/dev/null)
        case "$en" in true|false) ;; *) cgi_error "invalid_enabled" "enabled must be a boolean"; exit 0 ;; esac
        case "$lh" in ''|*[!0-9]*|????*) cgi_error "invalid_learn_hours" "learn_hours must be 0-168"; exit 0 ;; esac
        [ "$lh" -le 168 ] || { cgi_error "invalid_learn_hours" "learn_hours must be 0-168"; exit 0; }
        sg=$(printf '%s' "$POST_DATA" | jq -r 'if has("sms_guard") then (.sms_guard | tostring) else "keep" end' 2>/dev/null)
        case "$sg" in true|false|keep) ;; *) cgi_error "invalid_enabled" "sms_guard must be a boolean"; exit 0 ;; esac
        conf_merge '.enabled = ($e == "true") | .learn_hours = ($l | tonumber)
            | (if $s == "keep" then . else .sms_guard = ($s == "true") end)' --arg e "$en" --arg l "$lh" --arg s "$sg" \
            || { cgi_error "write_failed" "Could not save"; exit 0; }
        cgi_success
        ;;
    reset_baseline)
        rm -f "$KNOWN" "$SINCE" 2>/dev/null
        if [ -e "$KNOWN" ] || [ -e "$SINCE" ]; then
            cgi_error "write_failed" "Could not clear the known cells"; exit 0
        fi
        touch "$RELOAD" 2>/dev/null
        cgi_success
        ;;
    rayhunter_install)
        helper install || { helper_fail "Could not start the installation"; exit 0; }
        cgi_success
        ;;
    rayhunter_install_status)
        helper install-status
        if [ -n "$HELPER_OUT" ]; then printf '%s\n' "$HELPER_OUT"; else printf '{"success":true,"status":"idle"}\n'; fi
        ;;
    rayhunter_enable)
        helper enable || { helper_fail "Could not start Rayhunter"; exit 0; }
        conf_merge '.rayhunter = true' || { cgi_error "write_failed" "Rayhunter started, but the setting could not be saved"; exit 0; }
        cgi_success
        ;;
    rayhunter_disable)
        helper disable || { helper_fail "Could not stop Rayhunter"; exit 0; }
        conf_merge '.rayhunter = false' || { cgi_error "write_failed" "Could not save"; exit 0; }
        cgi_success
        ;;
    rayhunter_uninstall)
        helper uninstall || { helper_fail "Could not remove Rayhunter"; exit 0; }
        conf_merge '.rayhunter = false' || true
        cgi_success
        ;;
    *)
        cgi_error "unknown_action" "Unknown action"
        ;;
esac
exit 0

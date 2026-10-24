#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# esim.sh — eSIM profiles through lpac (qmanager_esim bridge). See docs/reference/esim.md.
#   GET [?refresh=1]   cached EID + profiles (read from the eSIM on first load or refresh), plus the download job
#   POST {action: refresh | enable | disable | delete | nickname | download | notify, iccid, name, code, confirm}

qlog_init "cgi_esim"
cgi_headers
cgi_handle_options

BRIDGE="${ESIM_BRIDGE:-/usrdata/qmanager/bin/qmanager_esim}"
LPAC="${ESIM_LPAC:-/usrdata/qmanager/bin/qmanager_lpac}"
STATE="${ESIM_STATE:-/tmp/qmanager_esim_state.json}"
JOB="${ESIM_JOB:-/tmp/qmanager_esim_job.json}"
LOCK="${ESIM_LOCK:-/tmp/qmanager_esim.lock}"

available=true
[ -x "$BRIDGE" ] && [ -x "$LPAC" ] || available=false

job_running() {
    local t
    [ -s "$JOB" ] && [ "$(jq -r '.running == true' "$JOB" 2>/dev/null)" = "true" ] || return 1
    # A job that stopped updating for 6 minutes died without writing its result.
    t=$(jq -r '.updated // .started // 0' "$JOB" 2>/dev/null)
    case "$t" in ''|*[!0-9]*) t=0 ;; esac
    [ $(( $(date +%s) - t )) -lt 360 ]
}

# refresh_state — read EID and profiles into $STATE (holds the eSIM lock).
refresh_state() {
    local info list
    info=$("$BRIDGE" info 2>/dev/null)
    list=$("$BRIDGE" list 2>/dev/null)
    jq -n --argjson ts "$(date +%s)" --arg info "$info" --arg list "$list" '
        ($info | try fromjson catch {success: false, error: "lpac_failed"}) as $i
        | ($list | try fromjson catch {success: false, error: "lpac_failed"}) as $l
        | {checked_at: $ts,
           euicc: ($i.success == true or $l.success == true),
           error: (if $i.success == true or $l.success == true then null else ($i.error // "lpac_failed") end),
           eid: ($i.data.eidValue // null),
           free_bytes: ($i.data.EUICCInfo2.extCardResource.freeNonVolatileMemory // null),
           profiles: (if $l.success == true then [$l.data[]? | {
               iccid, state: .profileState, nickname: .profileNickname,
               provider: .serviceProviderName, name: .profileName, class: .profileClass}] else [] end)}' \
        > "$STATE.tmp" 2>/dev/null && mv "$STATE.tmp" "$STATE"
}

# with_lock <cmd...> — one eSIM operation at a time.
with_lock() {
    exec 8>"$LOCK"
    flock -x -n 8 || { cgi_error "esim_busy" "Another eSIM operation is running"; exit 0; }
    "$@"
}

if [ "$REQUEST_METHOD" = "GET" ]; then
    # Busy (a download or another read): serve the last reading instead of waiting.
    if [ "$available" = "true" ] && ! job_running; then
        case "&$QUERY_STRING" in
            *"&refresh=1"*) want=1 ;;
            *) want=0; [ -s "$STATE" ] || want=1 ;;
        esac
        if [ "$want" = "1" ]; then
            exec 8>"$LOCK"
            flock -x -n 8 && refresh_state
            exec 8>&-
        fi
    fi
    state='null'; [ -s "$STATE" ] && state=$(cat "$STATE")
    job='null'; [ -s "$JOB" ] && job=$(cat "$JOB")
    jq -n --argjson av "$available" --argjson st "$state" --argjson job "$job" \
        '{success: true, available: $av, state: $st, job: $job}' 2>/dev/null \
        || cgi_error "read_failed" "Could not read the eSIM state"
    exit 0
fi

[ "$REQUEST_METHOD" = "POST" ] || cgi_method_not_allowed
cgi_read_post
[ "$available" = "true" ] || { cgi_error "not_installed" "eSIM tools are not installed"; exit 0; }
job_running && { cgi_error "esim_busy" "A profile download is still running"; exit 0; }

action=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)
iccid=$(printf '%s' "$POST_DATA" | jq -r '.iccid // empty' 2>/dev/null)
case "$action" in
    enable|disable|delete|nickname)
        case "$iccid" in ''|*[!0-9Ff]*) cgi_error "invalid_iccid" "Invalid ICCID"; exit 0 ;; esac ;;
esac

# run_op <verb> — runs the bridge, re-reads the profiles, prints the bridge result.
run_op() {
    local out
    if [ "$1" = "nickname" ]; then
        out=$(printf '%s' "$POST_DATA" | jq -r '.name // "" | gsub("[\r\n]"; " ")' | "$BRIDGE" nickname "$iccid" 2>/dev/null)
    else
        out=$("$BRIDGE" "$1" ${iccid:+"$iccid"} 2>/dev/null)
    fi
    # Enabling or disabling makes the modem re-read the SIM; give it a moment before listing.
    case "$1" in enable|disable) sleep 3 ;; esac
    refresh_state
    printf '%s' "$out" | jq -c 'if type == "object" then . else error end' 2>/dev/null \
        || printf '{"success":false,"error":"lpac_failed","detail":"no result"}\n'
}

case "$action" in
    refresh)
        with_lock refresh_state
        cgi_success ;;
    enable|disable|delete|nickname)
        res=$(with_lock run_op "$action")
        qlog_info "esim $action $iccid: $(printf '%s' "$res" | jq -r '.error // "ok"' 2>/dev/null)"
        printf '%s\n' "$res" ;;
    notify)
        res=$(with_lock run_op notify)
        printf '%s\n' "$res" ;;
    download)
        req=$(printf '%s' "$POST_DATA" | jq -c '{code: (.code // "" | tostring), confirm: (.confirm // "" | tostring)}' 2>/dev/null)
        case "$req" in *'"code":"LPA:1$'*|*'"code":"lpa:1$'*) ;; *) cgi_error "invalid_code" "The activation code must start with LPA:1\$"; exit 0 ;; esac
        exec 8>"$LOCK"
        flock -x -n 8 || { cgi_error "esim_busy" "Another eSIM operation is running"; exit 0; }
        printf '{"running":true,"started":%s,"step":"starting"}\n' "$(date +%s)" > "$JOB"
        # Detached: the download takes up to a few minutes; the page polls GET for $JOB.
        (
            printf '%s\n' "$req" | "$BRIDGE" -status "$JOB" download >/dev/null 2>&1
            if [ "$(jq -r '.result.success == true' "$JOB" 2>/dev/null)" = "true" ]; then
                "$BRIDGE" notify >/dev/null 2>&1
            fi
            refresh_state
        ) </dev/null >/dev/null 2>&1 &
        qlog_info "esim download started"
        cgi_success ;;
    *)
        cgi_error "unknown_action" "Unknown action" ;;
esac

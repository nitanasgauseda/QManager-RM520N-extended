#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# sim_card.sh — SIM card facts and SIM PIN management. See docs/reference/sim-card.md.
#   GET   {spn, smsc, state, pin_enabled, pin_retries, puk_retries, remembered, auto_unlock_stopped}
#   POST  {action: enable|disable|change|unlock|forget, pin, new_pin, remember}
# PINs reach qcmd with QCMD_QUIET=1 so a wrong one is never written to the log at the default level.

qlog_init "cgi_sim_card"
cgi_headers
cgi_handle_options

HELPER="/usr/bin/qmanager_secret_set"

# _crsm_hex <qcmd reply> — the hex payload of a successful +CRSM read.
_crsm_hex() { printf '%s' "$1" | tr -d '\r' | sed -n 's/^+CRSM: *144,0,"\([0-9A-Fa-f]*\)".*/\1/p' | head -n1; }

# PIN lock state, PIN and PUK attempts left. Sets pin_enabled (true|false|null), pin_retries, puk_retries, state.
read_pin_state() {
    local r
    pin_enabled=null; pin_retries=null; puk_retries=null; state=unknown
    r=$(qcmd 'AT+CLCK="SC",2' 2>/dev/null | tr -d '\r' | sed -n 's/^+CLCK: *\([01]\).*/\1/p')
    case "$r" in 1) pin_enabled=true ;; 0) pin_enabled=false ;; esac
    r=$(QCMD_QUIET=1 qcmd 'AT+QPINC="SC"' 2>/dev/null | tr -d '\r' | sed -n 's/^+QPINC: *"SC",\([0-9]*\),\([0-9]*\).*/\1 \2/p')
    [ -n "$r" ] && { pin_retries=${r% *}; puk_retries=${r#* }; }
    r=$(qcmd 'AT+CPIN?' 2>/dev/null | tr -d '\r' | sed -n 's/^+CPIN: *//p' | head -n1)
    case "$r" in
        READY) state=ready ;;
        "SIM PIN") state=pin ;;
        "SIM PUK") state=puk ;;
        "") state=unknown ;;
        *) state=other ;;
    esac
}

valid_pin() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "${#1}" -ge 4 ] && [ "${#1}" -le 8 ]; }

# Store or drop the PIN for auto-unlock; never fails the request (the SIM change already happened).
remember_pin() {
    if [ "$1" = "true" ]; then
        printf '%s\n' "$2" | $_SUDO "$HELPER" set sim_pin >/dev/null 2>&1 || qlog_warn "could not store the SIM PIN"
    else
        $_SUDO "$HELPER" clear sim_pin </dev/null >/dev/null 2>&1
    fi
}

if [ "$REQUEST_METHOD" = "GET" ]; then
    read_pin_state
    spn=""
    hex=$(_crsm_hex "$(qcmd 'AT+CRSM=176,28486,0,0,17' 2>/dev/null)")
    # EF_SPN: one display-condition byte, then the name in GSM 7-bit (ASCII for plain letters), FF padded.
    [ -n "$hex" ] && spn=$(printf '%s' "${hex#??}" | awk '{
        s = ""; for (i = 1; i + 1 <= length($0); i += 2) {
            v = (index("0123456789ABCDEF", toupper(substr($0, i, 1))) - 1) * 16 + index("0123456789ABCDEF", toupper(substr($0, i + 1, 1))) - 1
            if (v == 255) break
            if (v >= 32 && v < 127) s = s sprintf("%c", v)
        } print s }')
    smsc=$(qcmd 'AT+CSCA?' 2>/dev/null | tr -d '\r' | sed -n 's/^+CSCA: *"\([+0-9]*\)".*/\1/p' | head -n1)
    st=$($_SUDO "$HELPER" status </dev/null 2>/dev/null)
    rem=$(printf '%s' "$st" | jq -r '.sim_pin == true' 2>/dev/null); [ "$rem" = "true" ] || rem=false
    stop=$(printf '%s' "$st" | jq -r '.sim_pin_failed == true' 2>/dev/null); [ "$stop" = "true" ] || stop=false
    jq -n --arg spn "$spn" --arg smsc "$smsc" --arg state "$state" --argjson en "$pin_enabled" \
        --argjson pr "$pin_retries" --argjson ur "$puk_retries" --argjson rem "$rem" --argjson stop "$stop" \
        '{success: true, spn: (if $spn == "" then null else $spn end), smsc: (if $smsc == "" then null else $smsc end),
          state: $state, pin_enabled: $en, pin_retries: $pr, puk_retries: $ur, remembered: $rem, auto_unlock_stopped: $stop}'
    exit 0
fi

[ "$REQUEST_METHOD" = "POST" ] || { cgi_method_not_allowed; exit 0; }
cgi_read_post
action=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)
pin=$(printf '%s' "$POST_DATA" | jq -r '.pin // "" | tostring' 2>/dev/null)
new_pin=$(printf '%s' "$POST_DATA" | jq -r '.new_pin // "" | tostring' 2>/dev/null)
remember=$(printf '%s' "$POST_DATA" | jq -r 'if .remember == false then "false" else "true" end' 2>/dev/null)

if [ "$action" = "forget" ]; then
    remember_pin false
    cgi_success
    exit 0
fi

case "$action" in enable|disable|change|unlock) ;; *) cgi_error "unknown_action" "Unknown action"; exit 0 ;; esac
valid_pin "$pin" || { cgi_error "invalid_pin" "The PIN must be 4 to 8 digits"; exit 0; }
[ "$action" = "change" ] && ! valid_pin "$new_pin" && { cgi_error "invalid_pin" "The new PIN must be 4 to 8 digits"; exit 0; }

read_pin_state
[ "$state" = "puk" ] && { cgi_error "sim_puk" "The SIM is blocked and needs its PUK; unblock it in a phone"; exit 0; }
# One wrong PIN with one attempt left blocks the SIM, so the last attempt is left to a phone.
case "$pin_retries" in
    null) cgi_error "retries_unknown" "The modem did not report how many PIN attempts are left"; exit 0 ;;
    0|1) cgi_error "last_attempt" "Only $pin_retries PIN attempt left; enter it in a phone so the SIM is not blocked"; exit 0 ;;
esac
case "$action" in
    enable) [ "$pin_enabled" = "true" ] && { cgi_error "already_enabled" "The SIM PIN is already on"; exit 0; }
            cmd="AT+CLCK=\"SC\",1,\"$pin\"" ;;
    disable) [ "$pin_enabled" = "false" ] && { cgi_error "already_disabled" "The SIM PIN is already off"; exit 0; }
             cmd="AT+CLCK=\"SC\",0,\"$pin\"" ;;
    change) [ "$pin_enabled" = "true" ] || { cgi_error "pin_off" "Turn the SIM PIN on first"; exit 0; }
            cmd="AT+CPWD=\"SC\",\"$pin\",\"$new_pin\"" ;;
    unlock) [ "$state" = "pin" ] || { cgi_error "not_locked" "The SIM is not waiting for its PIN"; exit 0; }
            cmd="AT+CPIN=\"$pin\"" ;;
esac

if ! QCMD_QUIET=1 qcmd "$cmd" >/dev/null 2>&1; then
    read_pin_state
    qlog_warn "SIM PIN $action refused by the SIM"
    jq -n --argjson pr "$pin_retries" '{success: false, error: "wrong_pin", detail: "The SIM did not accept the PIN", pin_retries: $pr}'
    exit 0
fi
qlog_info "SIM PIN $action done"
case "$action" in
    enable|unlock) remember_pin "$remember" "$pin" ;;
    change) remember_pin "$remember" "$new_pin" ;;
    disable) remember_pin false ;;
esac
cgi_success

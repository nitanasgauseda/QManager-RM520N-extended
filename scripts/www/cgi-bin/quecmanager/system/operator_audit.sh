#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# operator_audit.sh — what the SIM allows the operator to do, and whether the operator edits plain HTTP.
#   GET                     read the SIM service table (read-only AT+CRSM)
#   POST header_test        one plain-HTTP request to an echo service; reports header names only
# See docs/reference/operator-audit.md.

qlog_init "cgi_operator_audit"
cgi_headers
cgi_handle_options

ECHO_URLS="${QM_ECHO_URLS:-http://httpbin.org/headers http://postman-echo.com/headers}"
UA="QManager-check"

# Headers the request itself or the echo services' own load balancers add.
EXPECTED='^(host|user-agent|accept|accept-encoding|connection|content-length|x-amzn-trace-id|x-forwarded-proto|x-forwarded-port|x-forwarded-host|x-request-start)$'
IDENTITY='msisdn|imsi|imei|^x-up-|x-acr|uidh|^x-wap-|subscriber|x-nokia|x-network-info|tm_user|^x-vf-|calling-line|x-subno|x-h3g'
PROXY='^(via|forwarded|x-forwarded-for|x-proxy-id|x-bluecoat-via|proxy-connection|x-cache|x-squid)'

fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -s --max-time 12 -A "$UA" -H 'Accept: */*' "$1" 2>/dev/null
    else
        wget -q -T 12 -U "$UA" --header 'Accept: */*' -O - "$1" 2>/dev/null
    fi
}

if [ "$REQUEST_METHOD" = "POST" ]; then
    cgi_read_post
    action=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)
    [ "$action" = "header_test" ] || { cgi_error "unknown_action" "Unknown action"; exit 0; }
    body=""
    for u in $ECHO_URLS; do
        body=$(fetch "$u")
        printf '%s' "$body" | jq -e '.headers | type == "object"' >/dev/null 2>&1 && break
        body=""
    done
    [ -n "$body" ] || { cgi_error "test_failed" "The test server could not be reached"; exit 0; }
    # Classified with grep, not jq regex: the modem's jq may be built without it.
    names=$(printf '%s' "$body" | jq -r '.headers | keys[]' 2>/dev/null | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_\n-' | cut -c1-60)
    [ -n "$names" ] || { cgi_error "test_failed" "The test server sent an unreadable answer"; exit 0; }
    got_ua=$(printf '%s' "$body" | jq -r '.headers | to_entries[] | select(.key | ascii_downcase == "user-agent") | .value' 2>/dev/null | head -n1)
    extra=$(printf '%s\n' "$names" | grep -Ev "$EXPECTED" | head -n 20)
    result="clean"
    if printf '%s\n' "$extra" | grep -Eq "$IDENTITY"; then result="identity"
    elif printf '%s\n' "$extra" | grep -Eq "$PROXY"; then result="proxy"
    elif [ "$got_ua" != "$UA" ]; then result="modified"
    elif [ -n "$extra" ]; then result="unexpected"
    fi
    printf '%s\n' "$extra" | jq -R . | jq -sc --arg r "$result" '{success: true, result: $r, headers: map(select(length > 0))}'
    exit 0
fi

[ "$REQUEST_METHOD" = "GET" ] || cgi_method_not_allowed

# EF_UST (6F38): bit n-1 of the table is service n (3GPP TS 31.102 §4.2.8).
ust=$(qcmd 'AT+CRSM=176,28472,0,0,0' 2>/dev/null | tr -d '\r' | sed -n 's/^+CRSM: *144,0,"\([0-9A-Fa-f]*\)".*/\1/p' | head -n1)
if [ -z "$ust" ]; then
    jq -n '{success: true, sim: {readable: false}}'
    exit 0
fi

svc() {
    awk -v h="$ust" -v n="$1" 'BEGIN {
        b = int((n - 1) / 8); bit = (n - 1) % 8
        s = toupper(substr(h, b * 2 + 1, 2))
        if (length(s) < 2) { print "false"; exit }
        v = (index("0123456789ABCDEF", substr(s, 1, 1)) - 1) * 16 + index("0123456789ABCDEF", substr(s, 2, 1)) - 1
        for (i = 0; i < bit; i++) v = int(v / 2)
        print (v % 2 == 1) ? "true" : "false"
    }'
}

jq -n --argjson dl "$(svc 28)" --argjson cb "$(svc 29)" --argjson cc "$(svc 30)" --argjson mo "$(svc 31)" \
    --argjson sa "$(svc 122)" --argjson priv "$(svc 124)" --argjson suci "$(svc 125)" '{
    success: true,
    sim: {
        readable: true,
        sms_download: $dl,
        cb_download: $cb,
        call_control: $cc,
        sms_control: $mo,
        sa_ready: $sa,
        id_privacy: $priv,
        id_privacy_in_sim: $suci
    }
}'

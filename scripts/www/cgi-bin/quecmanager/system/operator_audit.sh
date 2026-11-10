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
    printf '%s' "$body" | jq -c --arg ua "$UA" --arg exp "$EXPECTED" --arg idn "$IDENTITY" --arg prx "$PROXY" '
        (.headers | with_entries(.key |= ascii_downcase)) as $h
        | [$h | keys[] | select(test($exp) | not)] as $extra
        | [$extra[] | select(test($idn))] as $identity
        | [$extra[] | select(test($prx))] as $proxy
        | (($h["user-agent"] // "") != $ua) as $modified
        | {
            success: true,
            result: (if ($identity | length) > 0 then "identity"
                     elif ($proxy | length) > 0 then "proxy"
                     elif $modified then "modified"
                     elif ($extra | length) > 0 then "unexpected"
                     else "clean" end),
            headers: ($extra | map(.[0:60]) | .[0:20])
          }' 2>/dev/null || cgi_error "test_failed" "The test server sent an unreadable answer"
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

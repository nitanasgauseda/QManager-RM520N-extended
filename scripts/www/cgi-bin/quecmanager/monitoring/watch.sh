#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# watch.sh — settings and state of the poller's watch checks (usr/lib/qmanager/watch.sh).
#   GET                                    config, roaming state, public IP
#   POST save {roaming:{alert,block}, public_ip:{enabled}, router:{alert,address}}  (other keys kept)
#   POST check_ip                          look the public IP up again on the next poll cycle

qlog_init "cgi_watch"
cgi_headers
cgi_handle_options

CONF="${WT_CONFIG:-/etc/qmanager/watch.json}"
STATUS="${WT_STATUS:-/tmp/qmanager_watch.json}"
PUBIP="${WT_PUBIP:-/tmp/qmanager_pubip.json}"
RELOAD="${WT_RELOAD_FLAG:-/tmp/qmanager_watch_reload}"

if [ "$REQUEST_METHOD" = "GET" ]; then
    c='{}'; [ -s "$CONF" ] && c=$(jq -c '.' "$CONF" 2>/dev/null); [ -n "$c" ] || c='{}'
    st='null'; [ -s "$STATUS" ] && st=$(jq -c '.' "$STATUS" 2>/dev/null); [ -n "$st" ] || st='null'
    ip='null'; [ -s "$PUBIP" ] && ip=$(jq -c '.' "$PUBIP" 2>/dev/null); [ -n "$ip" ] || ip='null'
    jq -n --argjson c "$c" --argjson st "$st" --argjson ip "$ip" '{
        success: true,
        config: {
            roaming: {alert: ($c.roaming.alert != false), block: ($c.roaming.block == true)},
            public_ip: {enabled: ($c.public_ip.enabled != false)},
            router: {alert: ($c.router.alert != false), address: ($c.router.address // "")}
        },
        roaming: ($st.roaming // null),
        router: ($st.router // null),
        public_ip: $ip
    }'
    exit 0
fi

[ "$REQUEST_METHOD" = "POST" ] || cgi_method_not_allowed
cgi_read_post
action=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)
case "$action" in
    save)
        v=$(printf '%s' "$POST_DATA" | jq -r '[.roaming.alert, .roaming.block, .public_ip.enabled, (if .router.alert == null then true else .router.alert end)] | map(tostring) | join(" ")' 2>/dev/null)
        set -- $v
        for b in "$1" "$2" "$3" "$4"; do
            case "$b" in true|false) ;; *) cgi_error "invalid_value" "roaming.alert, roaming.block, public_ip.enabled and router.alert must be booleans"; exit 0 ;; esac
        done
        addr=$(printf '%s' "$POST_DATA" | jq -r '.router.address // "" | tostring' 2>/dev/null)
        if [ -n "$addr" ]; then
            printf '%s' "$addr" | awk -F. 'NF == 4 { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i + 0 > 255) exit 1; exit 0 } { exit 1 }' \
                || { cgi_error "invalid_address" "router.address must be an IPv4 address or empty"; exit 0; }
        fi
        # Keys this page does not edit (ippt.renew) are kept.
        old='{}'; [ -s "$CONF" ] && old=$(jq -c 'if type == "object" then . else {} end' "$CONF" 2>/dev/null); [ -n "$old" ] || old='{}'
        jq -n -c --argjson o "$old" --argjson a "$1" --argjson b "$2" --argjson p "$3" --argjson r "$4" --arg ad "$addr" \
            '$o + {roaming: {alert: $a, block: $b}, public_ip: {enabled: $p}, router: {alert: $r, address: $ad}}' \
            > "$CONF.tmp" 2>/dev/null && mv "$CONF.tmp" "$CONF" || { rm -f "$CONF.tmp"; cgi_error "write_failed" "Could not save"; exit 0; }
        touch "$RELOAD" 2>/dev/null
        cgi_success
        ;;
    check_ip)
        touch "$RELOAD" 2>/dev/null
        cgi_success
        ;;
    *) cgi_error "unknown_action" "Unknown action" ;;
esac

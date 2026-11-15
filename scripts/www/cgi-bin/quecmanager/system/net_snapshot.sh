#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# net_snapshot.sh — on-demand network snapshots for System Settings -> Security.
#   GET ?kind=fw   inbound packets QManager's firewall dropped (from the root poller)
#   GET ?kind=ct   live connections per source address
# Asks the poller (root) for a fresh snapshot when the last one is older than 5 s and returns
# what exists now: { success, kind, age (s, null if none), data (null if none) }.
# See docs/reference/net-snapshot.md.

qlog_init "cgi_net_snapshot"
cgi_headers
cgi_handle_options

[ "$REQUEST_METHOD" = "GET" ] || cgi_method_not_allowed

case "$QUERY_STRING" in
    *kind=fw*) kind=fw; file=/tmp/qmanager_fw_blocked.json; req=/tmp/qmanager_netsnap_fw ;;
    *kind=ct*) kind=ct; file=/tmp/qmanager_conntrack.json; req=/tmp/qmanager_netsnap_ct ;;
    *) cgi_error "bad_kind" "kind must be fw or ct" ;;
esac

read -r up _ < /proc/uptime 2>/dev/null || up=0
up=${up%%.*}
data=""; age=null
if [ -s "$file" ]; then
    data=$(jq -c 'select(type == "object")' "$file" 2>/dev/null)
    at=$(printf '%s' "$data" | jq -r '.updated // empty' 2>/dev/null)
    case "$at" in ''|*[!0-9]*) ;; *) [ "$up" -ge "$at" ] && age=$((up - at)) ;; esac
fi
if [ "$age" = "null" ] || [ "$age" -gt 5 ]; then
    : > "$req" 2>/dev/null
fi

jq -n -c --arg kind "$kind" --argjson age "$age" --argjson data "${data:-null}" \
    '{success: true, kind: $kind, age: $age, data: $data}'

#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# audit.sh — Activity log: sign-ins and settings changes written by cgi_base.sh's qm_audit.
#   GET            entries, newest first
#   POST clear     empty the log (the clear itself is the first new entry)

qlog_init "cgi_audit"
cgi_headers
cgi_handle_options

if [ "$REQUEST_METHOD" = "GET" ]; then
    entries='[]'
    if [ -s "$QM_AUDIT_LOG" ]; then
        entries=$(jq -R -s -c '[split("\n")[] | fromjson? | select(type == "object")] | reverse' "$QM_AUDIT_LOG" 2>/dev/null)
        [ -n "$entries" ] || entries='[]'
    fi
    jq -n --argjson e "$entries" --argjson max "$QM_AUDIT_MAX" '{success: true, entries: $e, max: $max}'
    exit 0
fi

[ "$REQUEST_METHOD" = "POST" ] || cgi_method_not_allowed
cgi_read_post
action=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)
[ "$action" = "clear" ] || { cgi_error "unknown_action" "Unknown action"; exit 0; }
: > "$QM_AUDIT_LOG" 2>/dev/null || { cgi_error "write_failed" "Could not clear the log"; exit 0; }
rm -f "$QM_AUDIT_RECENT" 2>/dev/null
qm_audit change "system/audit.sh" "clear"
cgi_success

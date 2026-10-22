#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# insights.sh — settings and live status for the data-plan limit, temperature alerts and signal history.
#   GET                                     config + /tmp/qmanager_insights.json status
#   POST save {data_limit:{...}, temperature:{...}, history:{...}}
# The poller (insights.sh) applies changes on its next cycle via a reload flag.

qlog_init "cgi_insights"
cgi_headers
cgi_handle_options

CONF="${QM_INSIGHTS_CONFIG:-/etc/qmanager/insights.json}"
STATUS="${QM_INSIGHTS_STATUS:-/tmp/qmanager_insights.json}"
RELOAD="/tmp/qmanager_insights_reload"

conf_json() {
    _c=""
    [ -f "$CONF" ] && _c=$(jq -c '.' "$CONF" 2>/dev/null)
    [ -n "$_c" ] || _c='{}'
    printf '%s' "$_c"
}

if [ "$REQUEST_METHOD" = "GET" ]; then
    st='null'
    [ -s "$STATUS" ] && st=$(jq -c '.' "$STATUS" 2>/dev/null || printf 'null')
    [ -n "$st" ] || st='null'
    jq -n --argjson c "$(conf_json)" --argjson s "$st" '{
        success: true,
        config: {
            data_limit: {
                enabled: ($c.data_limit.enabled == true),
                limit_gb: ($c.data_limit.limit_gb // 0),
                billing_day: ($c.data_limit.billing_day // 1),
                warn_pct: ($c.data_limit.warn_pct // 80)
            },
            temperature: {
                enabled: ($c.temperature.enabled != false),
                alert_c: ($c.temperature.alert_c // 75)
            },
            history: {
                enabled: ($c.history.enabled != false),
                days: ($c.history.days // 30)
            }
        },
        status: $s
    }'
    exit 0
fi

[ "$REQUEST_METHOD" = "POST" ] || { cgi_method_not_allowed; exit 0; }
cgi_read_post
ACTION=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)
[ "$ACTION" = "save" ] || { cgi_error "unknown_action" "Unknown action"; exit 0; }

# int_in <value> <min> <max> — a plain non-negative integer inside the range.
int_in() {
    case "$1" in ''|*[!0-9]*|??????*) return 1 ;; esac
    [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]
}
bool() { case "$1" in true|false) return 0 ;; esac; return 1; }
p() { printf '%s' "$POST_DATA" | jq -r "$1 | if . == null then \"\" else tostring end" 2>/dev/null; }

dl_en=$(p '.data_limit.enabled'); dl_gb=$(p '.data_limit.limit_gb'); dl_day=$(p '.data_limit.billing_day')
dl_warn=$(p '.data_limit.warn_pct'); dl_used=$(p '.data_limit.used_gb')
t_en=$(p '.temperature.enabled'); t_c=$(p '.temperature.alert_c')
h_en=$(p '.history.enabled'); h_days=$(p '.history.days')

bool "$dl_en" || { cgi_error "invalid_enabled" "data_limit.enabled must be a boolean"; exit 0; }
int_in "$dl_gb" 0 100000 || { cgi_error "invalid_limit" "limit_gb must be 0-100000"; exit 0; }
[ "$dl_en" = "true" ] && [ "$dl_gb" -eq 0 ] && { cgi_error "invalid_limit" "Set a plan size above 0 GB"; exit 0; }
int_in "$dl_day" 1 28 || { cgi_error "invalid_billing_day" "billing_day must be 1-28"; exit 0; }
int_in "$dl_warn" 50 99 || { cgi_error "invalid_warn" "warn_pct must be 50-99"; exit 0; }
bool "$t_en" || { cgi_error "invalid_enabled" "temperature.enabled must be a boolean"; exit 0; }
int_in "$t_c" 50 100 || { cgi_error "invalid_temperature" "alert_c must be 50-100"; exit 0; }
bool "$h_en" || { cgi_error "invalid_enabled" "history.enabled must be a boolean"; exit 0; }
int_in "$h_days" 1 90 || { cgi_error "invalid_days" "history.days must be 1-90"; exit 0; }

# Optional "used so far this cycle" in GB with up to 2 decimals; stored as whole MB.
used_mb=""
if [ -n "$dl_used" ]; then
    case "$dl_used" in
        *[!0-9.]*|*.*.*|.*|'') cgi_error "invalid_used" "used_gb must be a number"; exit 0 ;;
    esac
    used_mb=$(jq -n --arg v "$dl_used" '($v | tonumber) * 1024 | floor' 2>/dev/null)
    case "$used_mb" in ''|*[!0-9]*) cgi_error "invalid_used" "used_gb must be a number"; exit 0 ;; esac
fi

now=$(date +%s)
if ! conf_json | jq -c \
    --argjson dl_en "$dl_en" --argjson dl_gb "$dl_gb" --argjson dl_day "$dl_day" --argjson dl_warn "$dl_warn" \
    --argjson t_en "$t_en" --argjson t_c "$t_c" --argjson h_en "$h_en" --argjson h_days "$h_days" \
    --arg used_mb "$used_mb" --argjson now "$now" '
    .data_limit = ((.data_limit // {}) + {enabled: $dl_en, limit_gb: $dl_gb, billing_day: $dl_day, warn_pct: $dl_warn})
    | (if $used_mb != "" then .data_limit += {used_mb: ($used_mb | tonumber), set_at: $now} else . end)
    | .temperature = {enabled: $t_en, alert_c: $t_c}
    | .history = {enabled: $h_en, days: $h_days}' > "${CONF}.tmp" 2>/dev/null; then
    rm -f "${CONF}.tmp"
    cgi_error "write_failed" "Could not save"
    exit 0
fi
mv "${CONF}.tmp" "$CONF" || { cgi_error "write_failed" "Could not save"; exit 0; }
touch "$RELOAD" 2>/dev/null
cgi_success

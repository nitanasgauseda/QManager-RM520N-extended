#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# =============================================================================
# data_used.sh — CGI Endpoint: Accumulated Data Usage (GET)
# =============================================================================
# Serves the .data_used block from /tmp/qmanager_status.json.
# The block is written by the qmanager_poller on every tier-1 tick.
#
# Adds a "stale" boolean: true when the status cache timestamp is older
# than STALE_SECONDS (indicates the poller is not running).
# Returns a zeroed fallback shape (stale=true) when the cache is missing
# or the .data_used key is absent — the frontend never needs to guard
# against missing keys.
#
# Endpoint: GET /cgi-bin/quecmanager/network/data_used.sh
# Response: application/json
# Install location: /www/cgi-bin/quecmanager/network/data_used.sh
# =============================================================================

# --- Logging -----------------------------------------------------------------
qlog_init "cgi_data_used"
cgi_headers
cgi_handle_options

# --- Configuration -----------------------------------------------------------
STATUS_FILE="/tmp/qmanager_status.json"
STALE_SECONDS=10

# --- Method guard ------------------------------------------------------------
if [ "$REQUEST_METHOD" != "GET" ]; then
    cgi_method_not_allowed
    exit 0
fi

# --- Serve data --------------------------------------------------------------
if [ ! -f "$STATUS_FILE" ]; then
    qlog_warn "Status cache missing, returning zeroed fallback"
    jq -n '{
        "accumulated_rx_bytes": 0,
        "accumulated_tx_bytes": 0,
        "selected_counter": "",
        "last_update_ts": 0,
        "last_reset_ts": 0,
        "modem_reset_count": 0,
        "stale": true
    }'
    exit 0
fi

# One jq per request: the dashboard polls this every 2 s.
now=$(date +%s)
jq --argjson now "$now" --argjson max "$STALE_SECONDS" '
    (.data_used // {
        "accumulated_rx_bytes": 0,
        "accumulated_tx_bytes": 0,
        "selected_counter": "",
        "last_update_ts": 0,
        "last_reset_ts": 0,
        "modem_reset_count": 0
    }) + {stale: (($now - ((.timestamp // 0) | tonumber? // 0)) > $max)}' < "$STATUS_FILE" 2>/dev/null \
    || printf '{"accumulated_rx_bytes":0,"accumulated_tx_bytes":0,"selected_counter":"","last_update_ts":0,"last_reset_ts":0,"modem_reset_count":0,"stale":true}\n'

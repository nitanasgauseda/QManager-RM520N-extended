#!/bin/sh
# telegram_alerts.sh — Telegram Bot API transport for alert_engine.sh (send only, never "when").
# Token lives root-only in /etc/qmanager-secrets; see docs/reference/alerts.md.
# Install location: /usr/lib/qmanager/telegram_alerts.sh

[ -n "$_TELEGRAM_ALERTS_LOADED" ] && return 0
_TELEGRAM_ALERTS_LOADED=1

: "${_TA_CONFIG:=/etc/qmanager/telegram_alerts.json}"
: "${_TA_TOKEN_FILE:=/etc/qmanager-secrets/telegram_bot_token}"
: "${_TA_LOG_FILE:=/tmp/qmanager_telegram_log.json}"
: "${_TA_API_BASE:=https://api.telegram.org}"
_TA_RELOAD_FLAG="/tmp/qmanager_telegram_reload"
_TA_MAX_LOG=100

_ta_enabled="false"
_ta_chat_id=""
_ta_token_set="false"

# _ta_valid_chat_id <id> — numeric user/group id (groups are negative) or @channel.
_ta_valid_chat_id() {
    local body
    case "$1" in
        @*)
            body="${1#@}"
            [ -n "$body" ] && [ -z "$(printf '%s' "$body" | tr -d 'A-Za-z0-9_')" ] \
                && [ "${#body}" -ge 5 ] && [ "${#body}" -le 32 ]
            return $?
            ;;
        -*) body="${1#-}" ;;
        *)  body="$1" ;;
    esac
    case "$body" in ''|*[!0-9]*) return 1 ;; esac
    [ "${#body}" -le 20 ]
}

_ta_read_config() {
    _ta_enabled="false"
    _ta_chat_id=""
    _ta_token_set="false"
    [ -f "$_TA_CONFIG" ] || return 1

    _ta_enabled=$(jq -r '(.enabled) | if . == null then "false" else tostring end' "$_TA_CONFIG" 2>/dev/null)
    _ta_chat_id=$(jq -r '.chat_id // "" | tostring' "$_TA_CONFIG" 2>/dev/null)
    _ta_token_set=$(jq -r '(.token_set) | if . == true then "true" else "false" end' "$_TA_CONFIG" 2>/dev/null)

    [ "$_ta_enabled" = "true" ] || { _ta_enabled="false"; return 0; }
    if [ "$_ta_token_set" != "true" ] || ! _ta_valid_chat_id "$_ta_chat_id"; then
        _ta_enabled="false"
        return 1
    fi
    return 0
}

_ta_log_event() {
    local trigger="$1" status="$2" recipient="$3" ts count tmp
    ts=$(date "+%Y-%m-%d %H:%M:%S")
    [ -L "$_TA_LOG_FILE" ] && rm -f "$_TA_LOG_FILE"
    jq -n -c --arg ts "$ts" --arg trigger "$trigger" --arg status "$status" --arg recipient "$recipient" \
        '{timestamp: $ts, trigger: $trigger, status: $status, recipient: $recipient}' \
        >> "$_TA_LOG_FILE" 2>/dev/null

    count=$(wc -l < "$_TA_LOG_FILE" 2>/dev/null || echo 0)
    case "$count" in ''|*[!0-9]*) count=0 ;; esac
    if [ "$count" -gt "$_TA_MAX_LOG" ]; then
        tmp="${_TA_LOG_FILE}.tmp.$$"
        tail -n "$_TA_MAX_LOG" "$_TA_LOG_FILE" > "$tmp" 2>/dev/null && cat "$tmp" > "$_TA_LOG_FILE" 2>/dev/null
        rm -f "$tmp"
    fi
}

# telegram_send_raw <chat_id> <text> — 0 sent, 1 API/network failure, 2 no token, 3 no curl.
# The token goes to curl on stdin (-K -), never argv, which /proc/<pid>/cmdline exposes.
telegram_send_raw() {
    local chat="$1" text="$2" token resp rc
    command -v curl >/dev/null 2>&1 || return 3
    [ -r "$_TA_TOKEN_FILE" ] || return 2
    token=$(cat "$_TA_TOKEN_FILE" 2>/dev/null)
    [ -n "$token" ] || return 2

    resp=$(printf 'url = "%s/bot%s/sendMessage"\n' "$_TA_API_BASE" "$token" \
        | curl -sS --max-time 20 -K - \
            --data-urlencode "chat_id=${chat}" \
            --data-urlencode "text=${text}" \
            --data-urlencode "disable_web_page_preview=true" 2>/dev/null)
    rc=$?
    token=""
    [ "$rc" -eq 0 ] || return 1
    [ "$(printf '%s' "$resp" | jq -r '.ok == true' 2>/dev/null)" = "true" ] || return 1
    return 0
}

# telegram_alert_send <message> — engine entry point; uses the loaded config.
telegram_alert_send() {
    local rc
    if [ -z "$_ta_chat_id" ]; then
        qlog_warn "Telegram alerts: no chat id configured"
        return 1
    fi
    telegram_send_raw "$_ta_chat_id" "[QManager] $1"
    rc=$?
    [ "$rc" -eq 0 ] || qlog_warn "Telegram alerts: send failed (rc=$rc)"
    return "$rc"
}

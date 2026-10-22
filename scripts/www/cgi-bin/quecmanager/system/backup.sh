#!/bin/sh
# backup.sh — settings backup and restore.
#   GET                         download qmanager-settings-<date>.tar.gz (allowlisted files, no secrets)
#   POST ?action=inspect        body = backup file; returns its manifest and file list
#   POST ?action=restore        body = backup file; validates, then writes the files into /etc/qmanager
# cgi_base.sh enforces auth before any header is printed; this script prints its own headers.
. /usr/lib/qmanager/cgi_base.sh
qlog_init "cgi_backup"

CONF_DIR="${QM_BACKUP_CONF_DIR:-/etc/qmanager}"
SECRET_HELPER="${QM_SECRET_HELPER:-/usr/bin/qmanager_secret_set}"
MAX_BYTES=2097152
FORMAT=1

# Plain files at the top of CONF_DIR. Device-bound state (IMEI backup, SIM registry, boot ids, logs,
# the password) is deliberately absent.
ALLOW_FILES="qmanager.conf ping_profile.json quality_thresholds.json alert_routing.json email_alerts.json
sms_alerts.json discord_bot.json telegram_alerts.json sms_forwarding.json tower_lock.json band_failover_enabled
ttl_state ethernet_speed sites.json apn_setting.json apn_names.json ippt_config.json active_scenario
active_profile video_domains.txt tailscale_ssh cell_guard.json tower_map.json insights.json"
ALLOW_DIRS="profiles scenarios"

json_out() { printf 'Content-Type: application/json\r\nCache-Control: no-cache, no-store\r\n\r\n'; }
fail() { json_out; jq -n --arg e "$1" --arg d "$2" '{success:false, error:$e, detail:$d}'; exit 0; }

allowed_name() {
    case "$1" in
        */*/*|.*|*..*|'') return 1 ;;
        qmanager-backup.json) return 0 ;;
        */*)
            _d="${1%%/*}"; _f="${1#*/}"
            case " $ALLOW_DIRS " in *" $_d "*) ;; *) return 1 ;; esac
            case "$_f" in ''|*[!A-Za-z0-9._-]*|.*) return 1 ;; esac
            return 0 ;;
        *)
            for _a in $ALLOW_FILES; do [ "$1" = "$_a" ] && return 0; done
            return 1 ;;
    esac
}

# ============================================================================= download
if [ "$REQUEST_METHOD" = "GET" ]; then
    work=$(mktemp -d /tmp/qmanager_backup.XXXXXX 2>/dev/null) || fail "write_failed" "No temp space"
    trap 'rm -rf "$work"' EXIT
    mkdir -p "$work/s"
    count=0
    for f in $ALLOW_FILES; do
        [ -f "$CONF_DIR/$f" ] && [ ! -L "$CONF_DIR/$f" ] || continue
        cp "$CONF_DIR/$f" "$work/s/$f" && count=$((count + 1))
    done
    for d in $ALLOW_DIRS; do
        [ -d "$CONF_DIR/$d" ] && [ ! -L "$CONF_DIR/$d" ] || continue
        for f in "$CONF_DIR/$d"/*; do
            [ -f "$f" ] && [ ! -L "$f" ] || continue
            n="${f##*/}"
            allowed_name "$d/$n" || continue
            mkdir -p "$work/s/$d" && cp "$f" "$work/s/$d/$n" && count=$((count + 1))
        done
    done
    model=$(grep -m1 '^Project Name' /etc/quectel-project-version 2>/dev/null | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r')
    jq -n --argjson f "$FORMAT" --arg v "$(cat "$CONF_DIR/VERSION" 2>/dev/null | head -c 32)" \
        --arg m "$model" --argjson t "$(date +%s)" --argjson n "$count" \
        '{format: $f, app: "QManager", version: $v, model: $m, created: $t, files: $n}' > "$work/s/qmanager-backup.json"
    (cd "$work/s" && tar -cf - ./*) 2>/dev/null | gzip -c > "$work/b.tar.gz"
    [ -s "$work/b.tar.gz" ] || fail "build_failed" "The backup could not be created"
    name="qmanager-settings-$(date +%Y%m%d-%H%M).tar.gz"
    printf 'Content-Type: application/gzip\r\n'
    printf 'Content-Length: %s\r\n' "$(wc -c < "$work/b.tar.gz" | tr -d ' ')"
    printf 'Content-Disposition: attachment; filename="%s"\r\n' "$name"
    printf 'Cache-Control: no-cache, no-store, must-revalidate\r\n\r\n'
    cat "$work/b.tar.gz"
    exit 0
fi

[ "$REQUEST_METHOD" = "POST" ] || fail "method_not_allowed" "Use GET or POST"

action=""
case "&$QUERY_STRING" in
    *"&action="*) action="${QUERY_STRING#*action=}"; action="${action%%&*}" ;;
esac
case "$action" in inspect|restore) ;; *) fail "unknown_action" "action must be inspect or restore" ;; esac
case "${CONTENT_LENGTH:-}" in ''|*[!0-9]*) fail "no_body" "Upload a backup file" ;; esac
[ "$CONTENT_LENGTH" -gt 0 ] || fail "no_body" "Upload a backup file"
[ "$CONTENT_LENGTH" -le "$MAX_BYTES" ] || fail "too_large" "A settings backup is never larger than 2 MB"

work=$(mktemp -d /tmp/qmanager_restore.XXXXXX 2>/dev/null) || fail "write_failed" "No temp space"
trap 'rm -rf "$work"' EXIT
head -c "$CONTENT_LENGTH" > "$work/b.tar.gz"
gzip -t "$work/b.tar.gz" 2>/dev/null || fail "not_a_backup" "This is not a QManager settings backup"

# Every member must be a regular file or directory with an allowlisted name.
gzip -dc "$work/b.tar.gz" | tar -tvf - > "$work/list" 2>/dev/null || fail "not_a_backup" "This is not a QManager settings backup"
names=""
while read -r perm _o _s _d _t name _rest; do
    [ -n "$perm" ] || continue
    [ -z "$_rest" ] || fail "bad_member" "The backup contains an unexpected entry"
    name="${name#./}"
    case "$perm" in
        d*) case "$name" in ''|.) continue ;; esac
            name="${name%/}"
            case " $ALLOW_DIRS " in *" $name "*) continue ;; esac
            fail "bad_member" "The backup contains an unexpected folder" ;;
        -*) allowed_name "$name" || fail "bad_member" "The backup contains an unexpected file"
            names="$names $name" ;;
        *)  fail "bad_member" "The backup contains a link or special file" ;;
    esac
done < "$work/list"
case " $names " in *" qmanager-backup.json "*) ;; *) fail "not_a_backup" "This is not a QManager settings backup" ;; esac

mkdir -p "$work/x"
gzip -dc "$work/b.tar.gz" | (cd "$work/x" && tar -xf -) 2>/dev/null || fail "not_a_backup" "The backup could not be unpacked"
manifest=$(jq -c '.' "$work/x/qmanager-backup.json" 2>/dev/null)
[ "$(printf '%s' "$manifest" | jq -r '.app == "QManager" and .format == 1' 2>/dev/null)" = "true" ] \
    || fail "not_a_backup" "This is not a QManager settings backup"
for n in $names; do
    case "$n" in
        *.json|qmanager.conf) jq -e . "$work/x/$n" >/dev/null 2>&1 || fail "bad_member" "A file in the backup is damaged" ;;
    esac
done

files=$(printf '%s\n' $names | grep -v '^qmanager-backup.json$' | jq -R -s -c 'split("\n") | map(select(. != ""))')

if [ "$action" = "inspect" ]; then
    json_out
    jq -n --argjson m "$manifest" --argjson f "$files" '{success: true, manifest: $m, files: $f}'
    exit 0
fi

# Restore. Credentials never travel in a backup; keep each *_set marker true only if this device holds the secret.
sec=$($_SUDO "$SECRET_HELPER" status x </dev/null 2>/dev/null)
printf '%s' "$sec" | jq -e '.success == true' >/dev/null 2>&1 || sec='{}'
fix_marker() {
    [ -f "$work/x/$1" ] || return 0
    _has=$(printf '%s' "$sec" | jq -r --arg k "$3" '.[$k] == true')
    jq --arg m "$2" --argjson v "$_has" '.[$m] = $v' "$work/x/$1" > "$work/x/$1.tmp" && mv "$work/x/$1.tmp" "$work/x/$1"
}
fix_marker discord_bot.json token_set discord_bot_token
fix_marker telegram_alerts.json token_set telegram_bot_token
fix_marker email_alerts.json app_password_set email_app_password

restored=0
for n in $names; do
    [ "$n" = "qmanager-backup.json" ] && continue
    dest="$CONF_DIR/$n"
    mkdir -p "$(dirname "$dest")" 2>/dev/null
    [ -L "$dest" ] && rm -f "$dest"
    cp "$work/x/$n" "$dest.restore.tmp" 2>/dev/null && mv "$dest.restore.tmp" "$dest" 2>/dev/null \
        || { rm -f "$dest.restore.tmp"; fail "write_failed" "Some settings could not be written"; }
    restored=$((restored + 1))
done

touch /tmp/qmanager_sms_reload /tmp/qmanager_email_reload /tmp/qmanager_discord_reload \
      /tmp/qmanager_telegram_reload /tmp/qmanager_alert_routing_reload /tmp/qmanager_events_reload \
      /tmp/qmanager_cell_guard_reload /tmp/qmanager_insights_reload 2>/dev/null
qlog_info "settings restored: $restored files"

json_out
jq -n --argjson m "$manifest" --argjson f "$files" --argjson n "$restored" --argjson s "$sec" \
    '{success: true, manifest: $m, files: $f, restored: $n, needs_reboot: true,
      secrets_missing: [ ("discord_bot_token", "telegram_bot_token", "email_app_password") as $k
                         | select(($s[$k] // false) == false) | $k ]}'

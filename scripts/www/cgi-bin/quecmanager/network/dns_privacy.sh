#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
. /usr/lib/qmanager/dns_privacy.sh
# dns_privacy.sh — DNS Privacy: encrypted DNS (DNS over TLS) for every LAN device.
#   GET                         settings, daemon status
#   POST save {encrypt:{...}}
# Entware jq here has no regex support, so names are validated with awk.

qlog_init "cgi_dns_privacy"
cgi_headers
cgi_handle_options

RELOAD_FLAG="/tmp/qmanager_dnsguard_reload"
MOBILEAP_XML="${QM_MOBILEAP_XML:-/etc/data/mobileap_cfg.xml}"
PROVIDERS="quad9 cloudflare google adguard mullvad nextdns custom"

conf_json() {
    _c=""
    [ -f "$DP_CONFIG" ] && _c=$(jq -c '.' "$DP_CONFIG" 2>/dev/null)
    [ -n "$_c" ] || _c='{}'
    printf '%s' "$_c"
}

# Reported only: the redirect catches LAN DNS whatever resolver the devices were handed.
dns_mode() {
    [ -r "$MOBILEAP_XML" ] || { printf 'UNKNOWN'; return; }
    _m=$(grep -o '<DNSMode>[^<]*</DNSMode>' "$MOBILEAP_XML" 2>/dev/null | head -n1 | sed 's/<[^>]*>//g')
    if [ -n "$_m" ]; then printf '%s' "$_m"; else printf 'ABSENT'; fi
}

# valid_names — read names on stdin, print the normalised valid ones; exit 1 on the first invalid one.
valid_names() {
    awk '
        { d = tolower($0); gsub(/^[ \t]+|[ \t]+$/, "", d); sub(/^\*\./, "", d); sub(/\.$/, "", d) }
        d == "" { next }
        length(d) > 253 || d !~ /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)+$/ { bad = 1; exit }
        d ~ /^[0-9.]+$/ { bad = 1; exit }
        !(d in seen) { seen[d] = 1; print d }
        END { if (bad) exit 1 }'
}

if [ "$REQUEST_METHOD" = "GET" ]; then
    st='null'
    [ -s "$DP_STATUS" ] && st=$(jq -c '.' "$DP_STATUS" 2>/dev/null)
    [ -n "$st" ] || st='null'
    installed=false; [ -x "$DP_BIN" ] && installed=true
    running=false; svc_is_running qmanager_dnsguard && running=true
    healthy=false; dp_daemon_healthy && healthy=true
    present=false; dp_redirect_present && present=true
    rfail=false; [ -f "$DP_FAILED_FLAG" ] && rfail=true
    custom=false; dp_custom_dns_active && custom=true
    mode=$(dns_mode)
    jq -n --argjson c "$(conf_json)" --argjson s "$st" --argjson inst "$installed" --argjson run "$running" \
        --argjson ok "$healthy" --argjson live "$present" --argjson rfail "$rfail" --argjson custom "$custom" --arg mode "$mode" '{
        success: true,
        config: {
            encrypt: {
                enabled: ($c.encrypt.enabled == true),
                provider: ($c.encrypt.provider // "quad9"),
                fallback: ($c.encrypt.fallback != false),
                nextdns_id: ($c.encrypt.nextdns_id // ""),
                custom_host: ($c.encrypt.custom_host // ""),
                custom_ip: ($c.encrypt.custom_ip // "")
            }
        },
        service: {installed: $inst, running: $run, healthy: $ok, active: $live, redirect_failed: $rfail,
                  custom_dns_active: $custom, dns_mode: $mode,
                  available: true},
        status: (if $ok then $s else null end)
    }'
    exit 0
fi

[ "$REQUEST_METHOD" = "POST" ] || cgi_method_not_allowed
cgi_read_post
ACTION=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)

case "$ACTION" in
    save) ;;
    *) cgi_error "unknown_action" "Unknown action"; exit 0 ;;
esac

p() { printf '%s' "$POST_DATA" | jq -r "$1 | if . == null then \"\" else tostring end" 2>/dev/null; }
e_on=$(p '.encrypt.enabled'); prov=$(p '.encrypt.provider'); fb=$(p '.encrypt.fallback')
nid=$(p '.encrypt.nextdns_id'); chost=$(p '.encrypt.custom_host'); cip=$(p '.encrypt.custom_ip')

for v in "$e_on" "$fb"; do
    case "$v" in true|false) ;; *) cgi_error "invalid_enabled" "enabled and fallback must be booleans"; exit 0 ;; esac
done
case " $PROVIDERS " in *" $prov "*) ;; *) cgi_error "invalid_provider" "Unknown provider"; exit 0 ;; esac
if [ "$prov" = "nextdns" ]; then
    case "$nid" in ''|*[!a-z0-9]*) cgi_error "invalid_nextdns_id" "NextDNS ID is 4 to 16 letters or digits"; exit 0 ;; esac
    [ ${#nid} -ge 4 ] && [ ${#nid} -le 16 ] || { cgi_error "invalid_nextdns_id" "NextDNS ID is 4 to 16 letters or digits"; exit 0; }
else
    nid=$(printf '%s' "$nid" | tr -cd 'a-z0-9' | cut -c1-16)
fi
if [ "$prov" = "custom" ]; then
    chost=$(printf '%s\n' "$chost" | valid_names) && [ -n "$chost" ] \
        || { cgi_error "invalid_custom_host" "Enter the resolver's TLS host name"; exit 0; }
    printf '%s' "$cip" | awk -F. 'NF != 4 { exit 1 } { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i + 0 > 255) exit 1 }' \
        || { cgi_error "invalid_custom_ip" "Enter the resolver's IPv4 address"; exit 0; }
else
    chost=$(printf '%s\n' "$chost" | valid_names 2>/dev/null) || chost=""
    cip=""
fi

want="$e_on"
if [ "$want" = "true" ]; then
    [ -x "$DP_BIN" ] || { cgi_error "not_installed" "The DNS Privacy program is not installed"; exit 0; }
    dp_custom_dns_active && { cgi_error "custom_dns_active" "Turn off Custom DNS first"; exit 0; }
fi

if ! jq -n -c --argjson eon "$e_on" --arg prov "$prov" --argjson fb "$fb" --arg nid "$nid" --arg chost "$chost" \
    --arg cip "$cip" '{
        encrypt: {enabled: $eon, provider: $prov, fallback: $fb, nextdns_id: $nid, custom_host: $chost, custom_ip: $cip}}' > "$DP_CONFIG.tmp" 2>/dev/null \
    || ! mv "$DP_CONFIG.tmp" "$DP_CONFIG"; then
    rm -f "$DP_CONFIG.tmp"
    cgi_error "write_failed" "Could not save"
    exit 0
fi

if [ "$want" = "true" ]; then
    svc_enable qmanager_dnsguard >/dev/null 2>&1
    if svc_is_running qmanager_dnsguard && dp_daemon_healthy; then
        touch "$RELOAD_FLAG" 2>/dev/null
    else
        rm -f "$DP_STATUS" 2>/dev/null
        svc_restart qmanager_dnsguard
    fi
    i=0
    while [ "$i" -lt 12 ] && ! { dp_daemon_healthy && dp_lan_listening; }; do sleep 1; i=$((i + 1)); done
    if ! dp_daemon_healthy || ! dp_lan_listening; then
        cgi_error "daemon_failed" "DNS Privacy did not start; your DNS was left unchanged"
        exit 0
    fi
    dp_legacy_cleanup
    dp_guard_on
    rm -f "$DP_FAILED_FLAG" 2>/dev/null
    if ! dp_redirect_present; then
        if ! dp_redirect on; then
            cgi_error "apply_failed" "Saved, but LAN DNS could not be redirected"
            exit 0
        fi
        if ! dp_verify_redirect; then
            cgi_error "redirect_failed" "Lookups from your network did not reach DNS Privacy, so it was switched back off"
            exit 0
        fi
    fi
else
    rm -f "$DP_FAILED_FLAG" 2>/dev/null
    dp_redirect off
    dp_guard_off
    dp_legacy_cleanup
    svc_stop qmanager_dnsguard
    svc_disable qmanager_dnsguard >/dev/null 2>&1
fi
qlog_info "dns privacy saved: encrypt=$e_on provider=$prov"
cgi_success

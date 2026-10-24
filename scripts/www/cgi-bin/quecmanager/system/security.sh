#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# security.sh — Security Check: what the cellular side can reach, plus a few device settings worth knowing.
#   GET                                 run the checks (on demand only; nothing runs in the background)
#   POST block_port {proto, port}       close a port to the cellular side (IPv4 + IPv6, rmnet+ only)
#   POST unblock_port {proto, port}
#   POST set_privacy {stealth, lan_ipv6}   hide the modem from scans; turn IPv6 off for the LAN
# See docs/reference/security-check.md.

qlog_init "cgi_security"
cgi_headers
cgi_handle_options

WAN_CONF="${QM_WAN_BLOCK_CONF:-/etc/qmanager/wan_block.conf}"
FW_EVAL="${QM_FW_EVAL:-/usr/lib/qmanager/fw_eval.awk}"
IPT="${QM_IPTABLES:-/usr/sbin/iptables}"
IP6T="${QM_IP6TABLES:-/usr/sbin/ip6tables}"
NETSTAT_CMD="${QM_NETSTAT:-netstat -ltun}"
IP_ADDR_CMD="${QM_IP_ADDR:-ip addr show}"
MAX_BLOCKED=32
STEALTH_FLAG="${QM_STEALTH_FLAG:-/etc/qmanager/wan_stealth}"
LAN6_FLAG="${QM_LAN6_OFF_FLAG:-/etc/qmanager/lan_ipv6_off}"

service_name() {
    case "$1/$2" in
        tcp/22) echo ssh ;; tcp/23) echo telnet ;; tcp/80) echo web ;; tcp/443) echo web_https ;;
        */53) echo dns ;; tcp/7681) echo console ;; tcp/8686) echo rayhunter ;; tcp/8838) echo bridge_monitor ;;
        tcp/5555) echo adb ;; tcp/21) echo ftp ;; */5335) echo dns_privacy ;; udp/1900) echo upnp ;;
        *) echo other ;;
    esac
}

is_blocked_by_us() { grep -qx "$1 $2" "$WAN_CONF" 2>/dev/null; }

if [ "$REQUEST_METHOD" = "POST" ]; then
    cgi_read_post
    action=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)
    if [ "$action" = "set_privacy" ]; then
        st=$(printf '%s' "$POST_DATA" | jq -r '.stealth | if type == "boolean" then tostring else "" end' 2>/dev/null)
        l6=$(printf '%s' "$POST_DATA" | jq -r '.lan_ipv6 | if type == "boolean" then tostring else "" end' 2>/dev/null)
        [ -n "$st" ] && [ -n "$l6" ] || { cgi_error "invalid_request" "stealth and lan_ipv6 must be true or false"; exit 0; }
        if [ "$st" = "true" ]; then : > "$STEALTH_FLAG"; else rm -f "$STEALTH_FLAG"; fi
        # lan_ipv6 is "IPv6 on for the LAN"; the flag records it being off.
        if [ "$l6" = "false" ]; then : > "$LAN6_FLAG"; else rm -f "$LAN6_FLAG"; fi
        { [ "$st" = "false" ] || [ -f "$STEALTH_FLAG" ]; } && { [ "$l6" = "true" ] || [ -f "$LAN6_FLAG" ]; } \
            || { cgi_error "write_failed" "Could not save"; exit 0; }
        svc_restart qmanager_firewall || { cgi_error "apply_failed" "Saved, but the firewall could not be reloaded"; exit 0; }
        qlog_info "privacy: stealth=$st lan_ipv6=$l6"
        cgi_success
        exit 0
    fi
    proto=$(printf '%s' "$POST_DATA" | jq -r '.proto // empty' 2>/dev/null)
    port=$(printf '%s' "$POST_DATA" | jq -r '.port // empty | tostring' 2>/dev/null)
    case "$proto" in tcp|udp) ;; *) cgi_error "invalid_port" "proto must be tcp or udp"; exit 0 ;; esac
    case "$port" in ''|*[!0-9]*|??????*) cgi_error "invalid_port" "port must be 1-65535"; exit 0 ;; esac
    [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || { cgi_error "invalid_port" "port must be 1-65535"; exit 0; }
    touch "$WAN_CONF" 2>/dev/null
    case "$action" in
        block_port)
            if ! is_blocked_by_us "$proto" "$port"; then
                [ "$(grep -c . "$WAN_CONF" 2>/dev/null)" -lt "$MAX_BLOCKED" ] || { cgi_error "too_many" "At most $MAX_BLOCKED ports"; exit 0; }
                printf '%s %s\n' "$proto" "$port" >> "$WAN_CONF" || { cgi_error "write_failed" "Could not save"; exit 0; }
            fi ;;
        unblock_port)
            grep -vx "$proto $port" "$WAN_CONF" > "$WAN_CONF.tmp" 2>/dev/null
            mv "$WAN_CONF.tmp" "$WAN_CONF" || { cgi_error "write_failed" "Could not save"; exit 0; } ;;
        *) cgi_error "unknown_action" "Unknown action"; exit 0 ;;
    esac
    svc_restart qmanager_firewall || { cgi_error "apply_failed" "Saved, but the firewall could not be reloaded"; exit 0; }
    qlog_info "wan port $action: $proto $port"
    cgi_success
    exit 0
fi

[ "$REQUEST_METHOD" = "GET" ] || cgi_method_not_allowed

work=$(mktemp -d /tmp/qmanager_sec.XXXXXX 2>/dev/null) || { cgi_error "write_failed" "No temp space"; exit 0; }
trap 'rm -rf "$work"' EXIT

# --- Cellular interface and its addresses
$IP_ADDR_CMD 2>/dev/null | awk '
    /^[0-9]+: / { name = $2; sub(/:$/, "", name); sub(/@.*/, "", name); next }
    name ~ /^rmnet/ && $1 == "inet" { split($2, a, "/"); print "4 " name " " a[1] }
    name ~ /^rmnet/ && $1 == "inet6" && $0 ~ /scope global/ { split($2, a, "/"); print "6 " name " " a[1] }' > "$work/wan"
wan4_if=$(awk '$1 == 4 { print $2; exit }' "$work/wan"); wan4=$(awk '$1 == 4 { print $3; exit }' "$work/wan")
wan6_if=$(awk '$1 == 6 { print $2; exit }' "$work/wan"); wan6=$(awk '$1 == 6 { print $3; exit }' "$work/wan")
# Carrier-grade NAT or private IPv4: unsolicited traffic from the internet cannot arrive over IPv4.
v4_public=false
case "$wan4" in
    '') ;;
    10.*|192.168.*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;;
    *) v4_public=true ;;
esac
v6_public=false; [ -n "$wan6" ] && v6_public=true

# --- Firewall rules (www-data has sudo for iptables/ip6tables)
$_SUDO "$IPT" -S > "$work/ipt4" 2>/dev/null || : > "$work/ipt4"
$_SUDO "$IP6T" -S > "$work/ipt6" 2>/dev/null || : > "$work/ipt6"
fw_ok=true; [ -s "$work/ipt4" ] || fw_ok=false

# --- Listening sockets bound to every address or to the cellular address
$NETSTAT_CMD 2>/dev/null | awk -v w4="$wan4" -v w6="$wan6" '
    $1 ~ /^(tcp|udp)6?$/ {
        local = $4; n = split(local, parts, ":"); port = parts[n]
        addr = substr(local, 1, length(local) - length(port) - 1)
        proto = $1; fam = 4
        if (proto ~ /6$/) { proto = substr(proto, 1, 3); fam = 6 }
        if (addr == "::" || addr == "" || addr == "*") { fam = 6; any = 1 }
        else if (addr == "0.0.0.0") { fam = 4; any = 1 }
        else if (addr == w4) { fam = 4; any = 0 }
        else if (addr == w6) { fam = 6; any = 0 }
        else next
        if (proto == "udp" && (port == 67 || port == 68 || port == 546 || port == 547)) next
        k = proto " " port " " fam
        if (!(k in seen)) { seen[k] = 1; print k }
    }' | sort -u > "$work/listen"

# On Linux a [::] socket also takes IPv4 unless it is v6-only; check both families for it.
awk '$3 == 6 { print $1, $2, 4 } { print }' "$work/listen" | sort -u > "$work/check"

: > "$work/ports.ndjson"
while read -r proto port fam; do
    [ -n "$port" ] || continue
    if [ "$fam" = "4" ]; then
        [ -n "$wan4" ] || continue
        v=$(awk -v iface="$wan4_if" -v proto="$proto" -v port="$port" -v wanip="$wan4" -f "$FW_EVAL" "$work/ipt4" 2>/dev/null)
        public=$v4_public
    else
        [ -n "$wan6" ] || continue
        if [ -s "$work/ipt6" ]; then
            v=$(awk -v iface="$wan6_if" -v proto="$proto" -v port="$port" -v wanip="$wan6" -f "$FW_EVAL" "$work/ipt6" 2>/dev/null)
        else
            v="ACCEPT uncertain"
        fi
        public=$v6_public
    fi
    case "$v" in ACCEPT*) open=true ;; *) open=false ;; esac
    case "$v" in *uncertain*) unc=true ;; *) unc=false ;; esac
    ours=false; is_blocked_by_us "$proto" "$port" && ours=true
    jq -n -c --arg p "$proto" --argjson port "$port" --argjson fam "$fam" --arg svc "$(service_name "$proto" "$port")" \
        --argjson open "$open" --argjson unc "$unc" --argjson pub "$public" --argjson ours "$ours" \
        '{proto: $p, port: $port, family: $fam, service: $svc, open: $open, uncertain: $unc, public: $pub, blocked_by_qmanager: $ours}' \
        >> "$work/ports.ndjson"
done < "$work/check"

# --- Device settings
adb="unknown"
usb=$(qcmd 'AT+QCFG="usbcfg"' 2>/dev/null | tr -d '\r' | grep '+QCFG: "usbcfg"' | head -n1)
if [ -n "$usb" ]; then
    f9=$(printf '%s' "$usb" | awk -F, '{ gsub(/ /, "", $9); print $9 }')
    case "$f9" in 1) adb="on" ;; 0) adb="off" ;; esac
fi
adb_fix=""
[ "$adb" = "on" ] && adb_fix=$(printf '%s' "$usb" | sed 's/^+QCFG: //' | awk -F, 'BEGIN { OFS = "," } { $9 = "0"; print "AT+QCFG=" $0 }')

console=false; svc_is_running qmanager_console && console=true
https=false; $NETSTAT_CMD 2>/dev/null | grep -qE '^tcp6? .*:443 ' && https=true
cg=true; [ "$(jq -r '.enabled' /etc/qmanager/cell_guard.json 2>/dev/null)" = "false" ] && cg=false
dp=false; [ "$(jq -r '.encrypt.enabled == true' /etc/qmanager/dnsguard.json 2>/dev/null)" = "true" ] && dp=true
st=false; [ -f "$STEALTH_FLAG" ] && st=true
l6=true; [ -f "$LAN6_FLAG" ] && l6=false
st_act=false; grep -qx -- '-A INPUT -j QMANAGER_STEALTH' "$work/ipt4" && st_act=true
l6_off_act=false; grep -qx -- '-A FORWARD -j QMANAGER_LAN6' "$work/ipt6" && l6_off_act=true

jq -n --slurpfile ports "$work/ports.ndjson" --arg wan4 "$wan4" --arg wan6 "$wan6" \
    --argjson v4p "$v4_public" --argjson v6p "$v6_public" --argjson fw "$fw_ok" --arg adb "$adb" --arg adbfix "$adb_fix" \
    --argjson console "$console" --argjson https "$https" --argjson cg "$cg" --argjson dp "$dp" \
    --argjson st "$st" --argjson l6 "$l6" --argjson sta "$st_act" --argjson l6a "$l6_off_act" --argjson ts "$(date +%s)" '{
    success: true,
    checked_at: $ts,
    wan: {ipv4: $wan4, ipv6: $wan6, ipv4_public: $v4p, ipv6_public: $v6p, firewall_readable: $fw},
    ports: ($ports | sort_by(.port, .family)),
    device: {adb: $adb, adb_fix: $adbfix, web_console: $console, https: $https, cell_guard: $cg, encrypted_dns: $dp},
    privacy: {stealth: $st, lan_ipv6: $l6, stealth_active: $sta, lan_ipv6_off_active: $l6a}
}'

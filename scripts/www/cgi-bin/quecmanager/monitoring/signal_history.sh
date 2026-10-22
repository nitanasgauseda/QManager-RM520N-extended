#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# signal_history.sh — long-term signal history (written by insights.sh in the poller).
#   GET ?range=24h|7d|30d  -> bucketed series + per-cell statistics for the band advisor
# BusyBox 1.31 awk reads "NAME (" as a function call: never put a variable before "(".

qlog_init "cgi_signal_history"
cgi_headers
cgi_handle_options

HIST_DIR="${QM_SIGHIST_DIR:-/usrdata/qmanager/sighist}"
BUF="${QM_SIGHIST_BUF:-/tmp/qmanager_sighist_buf.csv}"

[ "$REQUEST_METHOD" = "GET" ] || { cgi_method_not_allowed; exit 0; }

range="24h"
case "&$QUERY_STRING" in
    *"&range="*) range="${QUERY_STRING#*range=}"; range="${range%%&*}" ;;
esac
case "$range" in
    24h) span=86400;   bucket=600 ;;
    7d)  span=604800;  bucket=3600 ;;
    30d) span=2592000; bucket=14400 ;;
    *) cgi_error "invalid_range" "range must be 24h, 7d or 30d"; exit 0 ;;
esac

now=$(date +%s)
start=$((now - span))
first_day=$((start / 86400))

set --
for f in "$HIST_DIR"/d*.csv; do
    [ -e "$f" ] || continue
    d="${f##*/d}"; d="${d%.csv}"
    case "$d" in ''|*[!0-9]*) continue ;; esac
    [ "$d" -ge "$first_day" ] && set -- "$@" "$f"
done
[ -s "$BUF" ] && set -- "$@" "$BUF"

days_stored=0; bytes_stored=0
for f in "$HIST_DIR"/d*.csv; do
    [ -e "$f" ] || continue
    days_stored=$((days_stored + 1))
    sz=$(wc -c < "$f" 2>/dev/null); case "$sz" in ''|*[!0-9]*) sz=0 ;; esac
    bytes_stored=$((bytes_stored + sz))
done

if [ "$#" -eq 0 ]; then
    jq -n --arg r "$range" --argjson b "$bucket" --argjson d "$days_stored" \
        '{success: true, range: $r, bucket_s: $b, points: [], cells: [], minutes: 0, days_stored: $d, bytes_stored: 0}'
    exit 0
fi

out=$(cat "$@" 2>/dev/null | awk -F, -v start="$start" -v bs="$bucket" '
    function num(v) { return v != "" && v ~ /^-?[0-9]+$/ }
    $1 ~ /^[0-9]+$/ && $1 + 0 >= start + 0 {
        total++
        b = int($1 / bs) * bs
        cnt[b]++
        if (num($6)) { lr[b] += $6; nlr[b]++ }
        if (num($8)) { ls[b] += $8; nls[b]++ }
        if (num($11)) { nr[b] += $11; nnr[b]++ }
        if (num($12)) { ns[b] += $12; nns[b]++ }
        if (num($13)) { tp[b] += $13; ntp[b]++; if (!(b in tmax) || $13 + 0 > tmax[b]) tmax[b] = $13 + 0 }
        if (num($14)) { rx[b] += $14; nrx[b]++ }
        if (num($15)) { tx[b] += $15 }

        if ($5 != "" || $3 != "") {
            k = $2 "|" $3 "|" $4 "|" $5 "|" $9
            cn[k]++
            if (num($6)) { crs[k] += $6; ncrs[k]++ }
            if (num($7)) { crq[k] += $7; ncrq[k]++ }
            if (num($8)) { csi[k] += $8; ncsi[k]++ }
            if (num($12)) { cns[k] += $12; ncns[k]++ }
            if (num($14) && $14 + 0 >= 5000000) { busy[k]++; brx[k] += $14 }
            if (num($14) && $14 + 0 > cmax[k]) cmax[k] = $14 + 0
            if ($1 + 0 > clast[k]) clast[k] = $1 + 0
        }
    }
    END {
        for (b in cnt) {
            printf "P %d {\"t\":%d", b, b
            if (nlr[b]) printf ",\"lrsrp\":%.1f", lr[b] / nlr[b]
            if (nls[b]) printf ",\"lsinr\":%.1f", ls[b] / nls[b]
            if (nnr[b]) printf ",\"nrsrp\":%.1f", nr[b] / nnr[b]
            if (nns[b]) printf ",\"nsinr\":%.1f", ns[b] / nns[b]
            if (ntp[b]) printf ",\"temp\":%.1f,\"temp_max\":%d", tp[b] / ntp[b], tmax[b]
            if (nrx[b]) printf ",\"dl_mbps\":%.2f,\"ul_mbps\":%.2f", rx[b] * 8 / (nrx[b] * 60) / 1000000, tx[b] * 8 / (nrx[b] * 60) / 1000000
            printf ",\"rx_bytes\":%.0f,\"tx_bytes\":%.0f}\n", rx[b], tx[b]
        }
        for (k in cn) {
            split(k, f, "|")
            printf "C {\"net\":\"%s\",\"lband\":\"%s\",\"pci\":\"%s\",\"enb\":\"%s\",\"nband\":\"%s\",\"minutes\":%d,\"last\":%d", f[1], f[2], f[3], f[4], f[5], cn[k], clast[k]
            if (ncrs[k]) printf ",\"rsrp\":%.1f", crs[k] / ncrs[k]
            if (ncrq[k]) printf ",\"rsrq\":%.1f", crq[k] / ncrq[k]
            if (ncsi[k]) printf ",\"sinr\":%.1f", csi[k] / ncsi[k]
            if (ncns[k]) printf ",\"nr_sinr\":%.1f", cns[k] / ncns[k]
            if (busy[k]) printf ",\"busy_minutes\":%d,\"busy_dl_mbps\":%.2f", busy[k], brx[k] * 8 / (busy[k] * 60) / 1000000
            printf ",\"peak_dl_mbps\":%.2f}\n", cmax[k] * 8 / 60 / 1000000
        }
        printf "T %d\n", total
    }')

points=$(printf '%s\n' "$out" | grep '^P ' | sort -n -k2 | cut -d' ' -f3- | jq -s -c '.' 2>/dev/null)
cells=$(printf '%s\n' "$out" | grep '^C ' | cut -d' ' -f2- | jq -s -c 'sort_by(-.minutes)' 2>/dev/null)
minutes=$(printf '%s\n' "$out" | sed -n 's/^T //p')
[ -n "$points" ] || points='[]'
[ -n "$cells" ] || cells='[]'
case "$minutes" in ''|*[!0-9]*) minutes=0 ;; esac

jq -n --arg r "$range" --argjson b "$bucket" --argjson p "$points" --argjson c "$cells" \
    --argjson m "$minutes" --argjson d "$days_stored" --argjson bytes "$bytes_stored" \
    '{success: true, range: $r, bucket_s: $b, points: $p, cells: $c, minutes: $m, days_stored: $d, bytes_stored: $bytes}'

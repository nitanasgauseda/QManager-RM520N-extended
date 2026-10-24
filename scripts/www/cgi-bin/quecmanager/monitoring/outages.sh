#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# outages.sh — internet outage statistics from the log watch.sh keeps (/etc/qmanager/outages.log).
#   GET ?days=7|30|90   totals, availability, outages by hour of day and by cell, the latest 20
# Log line: <start epoch> <end epoch> <eNB at the start> <network type>. One awk, no jq.

qlog_init "cgi_outages"
cgi_headers
cgi_handle_options

[ "$REQUEST_METHOD" = "GET" ] || cgi_method_not_allowed

LOG="${WT_OUTAGES:-/etc/qmanager/outages.log}"
OPEN="${WT_OPEN:-/tmp/qmanager_outage_open}"

days=30
case "&$QUERY_STRING" in *"&days=7"*) days=7 ;; *"&days=90"*) days=90 ;; esac

now=$(date +%s)
# Local hour of day: the offset from `date +%z` (+0200 -> 7200).
off=$(date +%z 2>/dev/null | awk '{ s = substr($0, 1, 1); h = substr($0, 2, 2) + 0; m = substr($0, 4, 2) + 0; o = h * 3600 + m * 60; print (s == "-" ? -o : o) }')
open_since=""
[ -s "$OPEN" ] && read -r open_since _rest < "$OPEN"
case "$open_since" in ''|*[!0-9]*) open_since="" ;; esac

{ [ -s "$LOG" ] && cat "$LOG"; } | awk -v now="$now" -v days="$days" -v off="${off:-0}" -v open="$open_since" '
    BEGIN { from = now - days * 86400; for (h = 0; h < 24; h++) { hc[h] = 0; hs[h] = 0 } }
    NF >= 2 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $2 > $1 {
        if ($2 <= from) next
        s = ($1 < from) ? from : $1; d = $2 - s
        n++; tot += d; if (d > mx) mx = d
        h = int((($1 + off) % 86400) / 3600); hc[h]++; hs[h] += d
        e = ($3 == "" ? "-" : $3); cc[e]++; cs[e] += d
        k++; rs[k] = $1; re[k] = $2; ren[k] = e; rn[k] = ($4 == "" ? "-" : $4)
    }
    function jstr(x) { gsub(/[^A-Za-z0-9._ -]/, "", x); return "\"" x "\"" }
    END {
        ongoing = (open != "" && open > 0)
        down = tot + (ongoing ? now - (open < from ? from : open) : 0)
        printf "{\"success\":true,\"days\":%d,\"now\":%d,", days, now
        printf "\"ongoing\":%s,", (ongoing ? sprintf("{\"since\":%d}", open) : "null")
        printf "\"count\":%d,\"downtime_s\":%d,\"longest_s\":%d,", n, down, mx
        printf "\"availability_pct\":%.3f,", 100 - down * 100 / (days * 86400)
        printf "\"by_hour\":["; for (h = 0; h < 24; h++) printf "%s%d", (h ? "," : ""), hc[h]; printf "],"
        printf "\"by_hour_s\":["; for (h = 0; h < 24; h++) printf "%s%d", (h ? "," : ""), hs[h]; printf "],"
        # Top 5 cells by downtime (selection: a handful of distinct cells).
        printf "\"cells\":["
        for (i = 1; i <= 5; i++) {
            best = ""; bv = -1
            for (c in cs) if (!(c in used) && cs[c] > bv) { bv = cs[c]; best = c }
            if (best == "") break
            used[best] = 1
            printf "%s{\"enb\":%s,\"count\":%d,\"downtime_s\":%d}", (i > 1 ? "," : ""), jstr(best), cc[best], cs[best]
        }
        printf "],\"recent\":["
        first = 1
        for (i = k; i >= 1 && i > k - 20; i--) {
            printf "%s{\"start\":%d,\"end\":%d,\"enb\":%s,\"net\":%s}", (first ? "" : ","), rs[i], re[i], jstr(ren[i]), jstr(rn[i])
            first = 0
        }
        printf "]}\n"
    }'

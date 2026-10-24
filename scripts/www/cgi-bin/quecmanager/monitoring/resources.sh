#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# resources.sh — Resources page: CPU and memory per process, memory, load and flash.
#   GET   one snapshot; CPU % is measured since the previous GET (the page polls every 5 s)
# Reads /proc only: one cat, one awk, one df. No jq.

qlog_init "cgi_resources"
cgi_headers
cgi_handle_options

[ "$REQUEST_METHOD" = "GET" ] || cgi_method_not_allowed

PROC="${QM_PROC:-/proc}"
PREV="${QM_RES_PREV:-/tmp/qmanager_resources_prev}"
TOP_N=15

# /proc/<pid>/stat lines vanish while being read; cat keeps going where awk would stop.
procs=$(cat "$PROC"/[0-9]*/stat 2>/dev/null)
cpu_line=$(head -n1 "$PROC/stat" 2>/dev/null)
flash=$(df -k /usrdata /etc 2>/dev/null | awk 'NR > 1 && NF >= 6 { printf "%s %s %s;", $6, $2, $3 }')

{
    printf 'CPU %s\n' "$cpu_line"
    awk '{ printf "MEM %s %s\n", $1, $2 }' "$PROC/meminfo" 2>/dev/null
    printf 'LOAD %s\n' "$(cat "$PROC/loadavg" 2>/dev/null)"
    printf 'UP %s\n' "$(cat "$PROC/uptime" 2>/dev/null)"
    printf 'FLASH %s\n' "$flash"
    [ -s "$PREV" ] && sed 's/^/PREV /' "$PREV"
    printf '%s\n' "$procs" | sed 's/^/P /'
} | awk -v top="$TOP_N" -v prevfile="$PREV.new" '
    function jstr(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return "\"" s "\"" }
    $1 == "CPU" { tot = 0; for (i = 3; i <= NF; i++) tot += $i; idle = $6 + $7; next }
    $1 == "MEM" { k = $2; sub(/:$/, "", k); mem[k] = $3; next }
    $1 == "LOAD" { l1 = $2; l5 = $3; l15 = $4; next }
    $1 == "UP" { up = int($2); next }
    $1 == "FLASH" { fl = $0; sub(/^FLASH /, "", fl); next }
    $1 == "PREV" {
        if ($2 == "TOTAL") { ptot = $3; pidle = $4 } else pj[$2] = $3
        next
    }
    $1 == "P" {
        line = substr($0, 3)
        # comm may hold spaces or parentheses: it runs from the first "(" to the last ")".
        if (!match(line, /\(.*\)/)) next
        pid = substr(line, 1, RSTART - 2)
        comm = substr(line, RSTART + 1, RLENGTH - 2)
        n = split(substr(line, RSTART + RLENGTH + 1), f, " ")
        if (n < 22) next
        key = pid ":" f[20]
        j = f[12] + f[13]
        np++
        P_key[np] = key; P_pid[np] = pid; P_comm[np] = comm; P_j[np] = j; P_rss[np] = f[22] * 4; P_state[np] = f[1]
        next
    }
    END {
        print "TOTAL", tot, idle > prevfile
        dt = tot - ptot
        have = (ptot > 0 && dt > 0)
        for (i = 1; i <= np; i++) {
            print P_key[i], P_j[i] > prevfile
            c = -1
            if (have && (P_key[i] in pj)) { c = (P_j[i] - pj[P_key[i]]) * 100 / dt; if (c < 0) c = 0 }
            P_cpu[i] = c
            order[i] = i
        }
        # Sort by CPU, then memory (insertion sort: a modem runs about 100 processes).
        for (i = 2; i <= np; i++) {
            v = order[i]; k = i - 1
            while (k >= 1 && (P_cpu[order[k]] < P_cpu[v] || (P_cpu[order[k]] == P_cpu[v] && P_rss[order[k]] < P_rss[v]))) {
                order[k + 1] = order[k]; k--
            }
            order[k + 1] = v
        }
        busy = -1
        if (have) { busy = 100 - (idle - pidle) * 100 / dt; if (busy < 0) busy = 0; if (busy > 100) busy = 100 }
        printf "{\"success\":true,\"cpu_pct\":%s,\"measured\":%s,", (busy < 0 ? "null" : sprintf("%.1f", busy)), (have ? "true" : "false")
        printf "\"mem\":{\"total_kb\":%d,\"available_kb\":%d,\"free_kb\":%d,\"cached_kb\":%d},", mem["MemTotal"], mem["MemAvailable"], mem["MemFree"], mem["Cached"]
        printf "\"load\":[%s,%s,%s],\"uptime\":%d,\"processes\":%d,", (l1 == "" ? 0 : l1), (l5 == "" ? 0 : l5), (l15 == "" ? 0 : l15), up, np
        printf "\"flash\":["
        nf = split(fl, fs, ";"); first = 1
        for (i = 1; i <= nf; i++) {
            if (split(fs[i], q, " ") < 3 || (q[1] in seenmnt)) continue
            seenmnt[q[1]] = 1
            printf "%s{\"mount\":%s,\"total_kb\":%d,\"used_kb\":%d}", (first ? "" : ","), jstr(q[1]), q[2], q[3]
            first = 0
        }
        printf "],\"top\":["
        shown = 0
        for (i = 1; i <= np && shown < top; i++) {
            x = order[i]
            # Kernel threads have no memory of their own; list them only while they use CPU.
            if (P_rss[x] == 0 && P_cpu[x] < 1) continue
            shown++
            printf "%s{\"pid\":%d,\"name\":%s,\"state\":%s,\"cpu_pct\":%s,\"rss_kb\":%d}", (shown > 1 ? "," : ""), P_pid[x], jstr(P_comm[x]), jstr(P_state[x]), (P_cpu[x] < 0 ? "null" : sprintf("%.1f", P_cpu[x])), P_rss[x]
        }
        printf "]}\n"
    }'
mv "$PREV.new" "$PREV" 2>/dev/null
exit 0

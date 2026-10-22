# fw_eval.awk — would a NEW packet from the internet reach a local port? Reads `iptables -S` / `ip6tables -S`.
# Variables: iface (e.g. rmnet_data0), proto (tcp|udp), port, wanip (address on iface, may be empty).
# Prints "ACCEPT" or "DROP", plus " uncertain" when a rule used a match this evaluator does not model.
# BusyBox 1.31 awk reads "NAME (" as a function call: never put a variable before "(".

function ifmatch(v) {
    if (v ~ /\+$/) return index(iface, substr(v, 1, length(v) - 1)) == 1
    return v == iface
}

function anyaddr(v) { return v == "0.0.0.0/0" || v == "::/0" || v == "0.0.0.0" || v == "::" }

function portmatch(v,   n, i, parts, r) {
    n = split(v, parts, ",")
    for (i = 1; i <= n; i++) {
        if (split(parts[i], r, ":") == 2) {
            if (port + 0 >= r[1] + 0 && port + 0 <= r[2] + 0) return 1
        } else if (parts[i] + 0 == port + 0) {
            return 1
        }
    }
    return 0
}

# matchrule — "" when the rule does not match, else its target (ACCEPT/DROP/REJECT/RETURN/CONTINUE/<chain>).
function matchrule(s,   t, n, i, neg, opt, val, m, target, odd) {
    n = split(s, t, " ")
    neg = 0; target = "CONTINUE"; odd = 0
    for (i = 3; i <= n; i++) {
        opt = t[i]
        if (opt == "!") { neg = 1; continue }
        if (opt == "-j" || opt == "-g") { target = t[++i]; continue }
        if (opt == "-m") { val = t[++i]; if (val !~ /^(tcp|udp|multiport|state|conntrack|comment|limit)$/) odd = 1; neg = 0; continue }
        if (opt == "--comment") {
            val = t[++i]
            if (val ~ /^"/ && val !~ /"$/) { while (i < n && t[i] !~ /"$/) i++ }
            neg = 0; continue
        }
        if (opt == "--syn" || opt == "--tcp-flags") { if (opt == "--tcp-flags") i += 2; neg = 0; continue }
        if (opt == "--limit" || opt == "--limit-burst") { i++; neg = 0; continue }
        val = t[++i]
        if (opt == "-i" || opt == "--in-interface") m = ifmatch(val)
        else if (opt == "-o" || opt == "--out-interface") m = 0
        else if (opt == "-p" || opt == "--protocol") m = (val == proto || val == "all" || val == "0")
        else if (opt == "--dport" || opt == "--destination-port" || opt == "--dports" || opt == "--destination-ports") m = portmatch(val)
        else if (opt == "-s" || opt == "--source") m = anyaddr(val)
        else if (opt == "-d" || opt == "--destination") m = anyaddr(val) || (wanip != "" && (val == wanip || index(val, wanip "/") == 1))
        else if (opt == "--state" || opt == "--ctstate") m = (("," val ",") ~ /,NEW,/)
        else { odd = 1; m = 1 }
        if (neg) m = !m
        neg = 0
        if (!m) return ""
    }
    if (odd) { uncertain = 1; return "" }
    return target
}

function evalchain(c, depth,   k, r, res) {
    if (depth > 8) return ""
    for (k = 1; k <= cnt[c]; k++) {
        r = matchrule(rule[c, k])
        if (r == "" || r == "CONTINUE") continue
        if (r == "ACCEPT" || r == "DROP" || r == "REJECT") return r
        if (r == "RETURN") return ""
        if (r in cnt) {
            res = evalchain(r, depth + 1)
            if (res != "") return res
            continue
        }
        if (r !~ /^(LOG|NFLOG|ULOG|MARK|CONNMARK|TCPMSS|TTL|HL|CLASSIFY|DSCP|TOS)$/) uncertain = 1
    }
    return ""
}

{
    if ($1 == "-P") pol[$2] = $3
    else if ($1 == "-N") { if (!($2 in cnt)) cnt[$2] = 0 }
    else if ($1 == "-A") { if (!($2 in cnt)) cnt[$2] = 0; cnt[$2]++; rule[$2, cnt[$2]] = $0 }
}

END {
    v = evalchain("INPUT", 0)
    if (v == "") v = ("INPUT" in pol) ? pol["INPUT"] : "ACCEPT"
    if (v == "REJECT") v = "DROP"
    out = v
    if (uncertain) out = out " uncertain"
    print out
}

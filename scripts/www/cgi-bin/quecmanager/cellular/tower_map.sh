#!/bin/sh
. /usr/lib/qmanager/cgi_base.sh
# tower_map.sh — Tower Map: local OpenCelliD tower index, home position, user tower corrections.
#   GET                      state (home, corrections, index summary)
#   GET ?towers=<mcc>        the eNB index for one MCC (built by update_db)
#   POST update_db {mcc}     download the MCC file (OpenCelliD with the user's key, else the mirror), build the index
#   POST save_token {token} | clear_token   the user's OpenCelliD key; GET only reports whether one is set
#   POST save_home {lat,lon} | clear_home
#   POST set_override {key,lat,lon} | clear_override {key}   key = <mcc>-<mnc>-<enb>
# See docs/reference/tower-map.md.

qlog_init "cgi_tower_map"
cgi_headers
cgi_handle_options

. /usr/lib/qmanager/downloader.sh

CONF="${QM_TOWER_CONF:-/etc/qmanager/tower_map.json}"
DB_DIR="${QM_TOWER_DB_DIR:-/etc/qmanager/towers}"
MIRROR="${QM_TOWER_MIRROR:-https://github.com/NorthveilSystems/treadstone-celldata/releases/latest/download}"
SCAN_TMP="${QM_TOWER_SCAN_TMP:-/tmp/qmanager_cell_scan_result.json}"
SCAN_SAVED="${QM_TOWER_DB_DIR:-/etc/qmanager/towers}/last_scan.json"
# Both hosts serve the same exports; the second is where opencellid.org's own links have pointed.
OCID_URLS="${QM_OCID_URL:-https://opencellid.org/ocid/downloads https://download.unwiredlabs.com/ocid/downloads}"
TOKEN_FILE="${QM_OCID_TOKEN_FILE:-/etc/qmanager/opencellid_token}"
ATTRIBUTION="Cell tower data from OpenCelliD (https://opencellid.org), CC BY-SA 4.0"

ocid_token() { [ -s "$TOKEN_FILE" ] && head -n1 "$TOKEN_FILE" 2>/dev/null | tr -cd 'A-Za-z0-9._-'; }

# ocid_fetch <mcc> <out> — today's export from OpenCelliD; on failure prints an error slug.
# The key goes to curl on stdin, never on its command line.
ocid_fetch() {
    _err=download_failed
    for _base in $OCID_URLS; do
        _err=$(ocid_fetch_one "$_base" "$1" "$2") && return 0
        [ "$_err" = download_failed ] || break
    done
    printf '%s' "$_err"
    return 1
}

ocid_fetch_one() {
    rm -f "$3"
    _url="$1?token=$(ocid_token)&type=mcc&file=$2.csv.gz"
    if command -v curl >/dev/null 2>&1; then
        printf 'url = "%s"\n' "$_url" | curl -sSL --max-time 180 --max-filesize 52428800 -K - -o "$3" 2>/dev/null
    else
        wget -q -T 180 -O "$3" "$_url" 2>/dev/null
    fi
    if [ "$(head -c 2 "$3" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "1f8b" ] && gzip -t "$3" 2>/dev/null; then
        return 0
    fi
    # Errors come back as a short text body.
    _body=$(head -c 300 "$3" 2>/dev/null | tr 'A-Z' 'a-z')
    case "$_body" in
        *rate*|*limit*) printf 'rate_limited' ;;
        *token*|*key*|*unauthori*|*invalid*) printf 'invalid_token' ;;
        *) printf 'download_failed' ;;
    esac
    return 1
}

conf_json() {
    _c=""
    [ -f "$CONF" ] && _c=$(jq -c '.' "$CONF" 2>/dev/null)
    [ -n "$_c" ] || _c='{}'
    printf '%s' "$_c"
}

# conf_write <jq filter> [jq args...] — atomic merge-write of the config.
conf_write() {
    _filter="$1"; shift
    _cur=$(conf_json)
    mkdir -p "$(dirname "$CONF")" 2>/dev/null
    if ! printf '%s' "$_cur" | jq -c "$@" "$_filter" > "${CONF}.tmp" 2>/dev/null; then
        rm -f "${CONF}.tmp"
        return 1
    fi
    mv "${CONF}.tmp" "$CONF"
}

# valid_coord <lat> <lon> — finite decimal degrees in range.
valid_coord() {
    case "$1$2" in ''|*[!0-9.-]*) return 1 ;; esac
    awk -v a="$1" -v o="$2" 'BEGIN {
        if (a !~ /^-?[0-9]+(\.[0-9]+)?$/ || o !~ /^-?[0-9]+(\.[0-9]+)?$/) exit 1
        if (a+0 < -90 || a+0 > 90 || o+0 < -180 || o+0 > 180) exit 1
        exit 0 }'
}

valid_mcc() { case "$1" in [2-7][0-9][0-9]) return 0 ;; esac; return 1; }

valid_key() {
    case "$1" in
        *[!0-9-]*|'') return 1 ;;
    esac
    _m="${1%%-*}"; _r="${1#*-}"; _n="${_r%%-*}"; _e="${_r#*-}"
    valid_mcc "$_m" || return 1
    case "$_n" in ''|*[!0-9]*|????*) return 1 ;; esac
    case "$_e" in ''|*[!0-9]*|???????????*) return 1 ;; esac
    [ "$_r" != "$_n" ]
}

# build_index <mcc> <csv.gz> <out.json> <generated> <source> — one row per (mnc, eNB/gNB):
# the samples-weighted centroid of its sectors, which sits nearer the mast than any one sector.
build_index() {
    gzip -dc "$2" 2>/dev/null | awk -F, -v mcc="$1" -v gen="$4" -v src="${5:-mirror}" -v built="$(date +%s)" '
        $2 != mcc { next }
        $1 == "LTE" { r = "L"; id = int($5 / 256) }
        $1 == "NR"  { r = "N"; id = int($5 / 16384) }
        $1 != "LTE" && $1 != "NR" { next }
        {
            # BusyBox 1.31 awk reads "NAME (" as a function call, so no variable is followed by "(".
            mnc = $3 + 0
            k = r SUBSEP mnc SUBSEP id
            w = $10 + 0
            if (w <= 0) w = 1
            sw[k] += w; sla[k] += $8 * w; slo[k] += $7 * w
            n[k]++; s[k] += $10; if ($13 + 0 > u[k]) u[k] = $13 + 0
            if ($9 + 0 > rg[k]) rg[k] = $9 + 0
        }
        END {
            printf "{\"mcc\":%d,\"generated\":\"%s\",\"source\":\"%s\",\"built\":%d,\"towers\":[", mcc, gen, src, built
            first = 1
            for (k in n) {
                split(k, p, SUBSEP)
                sep = ","
                if (first) sep = ""
                la = sla[k] / sw[k]
                lo = slo[k] / sw[k]
                printf "%s{\"r\":\"%s\",\"m\":%d,\"e\":%d,\"la\":%.5f,\"lo\":%.5f,\"c\":%d,\"s\":%d,\"u\":%d,\"g\":%d}", sep, p[1], p[2], p[3], la, lo, n[k], s[k], u[k], rg[k]
                first = 0
            }
            printf "]}\n"
        }' > "$3"
}

# =============================================================================
if [ "$REQUEST_METHOD" = "GET" ]; then
    mcc_q=""
    case "&$QUERY_STRING" in
        *"&towers="*) mcc_q="${QUERY_STRING#*towers=}"; mcc_q="${mcc_q%%&*}" ;;
    esac
    if [ -n "$mcc_q" ]; then
        valid_mcc "$mcc_q" || { cgi_error "invalid_mcc" "mcc must be 3 digits"; exit 0; }
        if [ -s "$DB_DIR/$mcc_q.json" ]; then
            cat "$DB_DIR/$mcc_q.json"
        else
            cgi_error "no_database" "No tower database for this MCC yet"
        fi
        exit 0
    fi

    dbs="[]"
    for f in "$DB_DIR"/[0-9][0-9][0-9].json; do
        [ -s "$f" ] || continue
        _row=$(jq -c '{mcc, generated, source: (.source // "mirror"), built, towers: (.towers | length)}' "$f" 2>/dev/null) || continue
        dbs=$(printf '%s' "$dbs" | jq -c --argjson r "$_row" '. + [$r]')
    done
    # The last Cell Scanner sweep lives in /tmp; keep a copy so the map still shows it after a reboot.
    scan='null'
    if [ -s "$SCAN_TMP" ] && { [ ! -f "$SCAN_SAVED" ] || [ "$SCAN_TMP" -nt "$SCAN_SAVED" ]; }; then
        if jq -e 'type == "array"' "$SCAN_TMP" >/dev/null 2>&1; then
            mkdir -p "$DB_DIR" 2>/dev/null
            jq -c --argjson t "$(date +%s)" '{at: $t, cells: .}' "$SCAN_TMP" > "$SCAN_SAVED.tmp" 2>/dev/null \
                && mv "$SCAN_SAVED.tmp" "$SCAN_SAVED" 2>/dev/null
        fi
    fi
    [ -s "$SCAN_SAVED" ] && scan=$(jq -c '{at, cells: [.cells[] | {type: .networkType, mcc, mnc, cell: .cellID,
        pci, band, rsrp: .signalStrength, provider}]}' "$SCAN_SAVED" 2>/dev/null)
    [ -n "$scan" ] || scan='null'

    has_token=false; [ -n "$(ocid_token)" ] && has_token=true
    jq -n --argjson c "$(conf_json)" --argjson dbs "$dbs" --arg attr "$ATTRIBUTION" --argjson scan "$scan" \
        --argjson tok "$has_token" '{
        success: true,
        has_token: $tok,
        home: ($c.home // null),
        overrides: ($c.overrides // {}),
        databases: $dbs,
        scan: $scan,
        attribution: $attr
    }'
    exit 0
fi

if [ "$REQUEST_METHOD" != "POST" ]; then
    cgi_method_not_allowed
    exit 0
fi

cgi_read_post
ACTION=$(printf '%s' "$POST_DATA" | jq -r '.action // empty' 2>/dev/null)
p_str() { printf '%s' "$POST_DATA" | jq -r --arg k "$1" '.[$k] // "" | tostring' 2>/dev/null; }

case "$ACTION" in
    update_db)
        mcc=$(p_str mcc)
        valid_mcc "$mcc" || { cgi_error "invalid_mcc" "mcc must be 3 digits"; exit 0; }
        qm_downloader >/dev/null || { cgi_error "no_downloader" "Neither curl nor wget is installed"; exit 0; }

        work=$(mktemp -d /tmp/qmanager_towers.XXXXXX 2>/dev/null) || { cgi_error "write_failed" "No temp space"; exit 0; }
        trap 'rm -rf "$work"' EXIT
        if [ -n "$(ocid_token)" ]; then
            src=opencellid
            gen=$(date -u +%Y-%m-%dT%H:%M:%SZ)
            if ! err=$(ocid_fetch "$mcc" "$work/cells.csv.gz"); then
                qlog_warn "opencellid download for $mcc failed: $err"
                case "$err" in
                    rate_limited) cgi_error "rate_limited" "OpenCelliD allows two downloads a day; try again tomorrow" ;;
                    invalid_token) cgi_error "invalid_token" "OpenCelliD did not accept the key" ;;
                    *) cgi_error "download_failed" "Could not download from OpenCelliD" ;;
                esac
                exit 0
            fi
        else
            src=mirror
            if ! qm_download "$MIRROR/manifest.json" "$work/manifest.json" 30 2>/dev/null; then
                cgi_error "download_failed" "Could not reach the tower database"; exit 0
            fi
            want=$(jq -r --argjson m "$mcc" '.files[] | select(.mcc == $m) | .sha256' "$work/manifest.json" 2>/dev/null)
            gen=$(jq -r '.generatedAt // ""' "$work/manifest.json" 2>/dev/null)
            [ -n "$want" ] || { cgi_error "mcc_not_found" "The tower database has no data for this country"; exit 0; }

            if ! qm_download "$MIRROR/$mcc.csv.gz" "$work/cells.csv.gz" 90 2>/dev/null; then
                cgi_error "download_failed" "Could not download the tower database"; exit 0
            fi
            got=$(sha256sum "$work/cells.csv.gz" 2>/dev/null | awk '{print $1}')
            if [ "$got" != "$want" ]; then
                qlog_error "tower db sha256 mismatch for $mcc"
                cgi_error "checksum_mismatch" "The downloaded file failed its integrity check"; exit 0
            fi
        fi

        build_index "$mcc" "$work/cells.csv.gz" "$work/index.json" "$gen" "$src"
        count=$(jq -r '.towers | length' "$work/index.json" 2>/dev/null)
        case "$count" in ''|*[!0-9]*|0) cgi_error "build_failed" "The tower database could not be read"; exit 0 ;; esac
        # OpenCelliD's export holds only cells seen in the last 18 months: keep older towers from the previous index.
        if [ "$src" = opencellid ] && [ -s "$DB_DIR/$mcc.json" ]; then
            if jq -c --slurpfile o "$DB_DIR/$mcc.json" '
                (reduce .towers[] as $t ({}; .["\($t.r)|\($t.m)|\($t.e)"] = 1)) as $have
                | .towers += [$o[0].towers[] | select($have["\(.r)|\(.m)|\(.e)"] == null)]' \
                "$work/index.json" > "$work/merged.json" 2>/dev/null && [ -s "$work/merged.json" ]; then
                mv "$work/merged.json" "$work/index.json"
                count=$(jq -r '.towers | length' "$work/index.json" 2>/dev/null)
            fi
        fi

        mkdir -p "$DB_DIR" 2>/dev/null
        cp "$work/index.json" "$DB_DIR/.$mcc.json.tmp" && mv "$DB_DIR/.$mcc.json.tmp" "$DB_DIR/$mcc.json" \
            || { cgi_error "write_failed" "Could not save the tower database"; exit 0; }
        qlog_info "tower db $mcc built from $src: $count towers"
        jq -n --argjson n "$count" --arg g "$gen" --arg s "$src" '{success:true, towers:$n, generated:$g, source:$s}'
        ;;

    save_token)
        tok=$(p_str token)
        case "$tok" in ''|*[!A-Za-z0-9._-]*) cgi_error "invalid_token_format" "Paste the key exactly as OpenCelliD shows it"; exit 0 ;; esac
        [ ${#tok} -ge 8 ] && [ ${#tok} -le 64 ] || { cgi_error "invalid_token_format" "Paste the key exactly as OpenCelliD shows it"; exit 0; }
        mkdir -p "$(dirname "$TOKEN_FILE")" 2>/dev/null
        ( umask 077; printf '%s\n' "$tok" > "$TOKEN_FILE.tmp" ) && mv "$TOKEN_FILE.tmp" "$TOKEN_FILE" \
            || { rm -f "$TOKEN_FILE.tmp"; cgi_error "write_failed" "Could not save"; exit 0; }
        cgi_success
        ;;

    clear_token)
        rm -f "$TOKEN_FILE" || { cgi_error "write_failed" "Could not save"; exit 0; }
        cgi_success
        ;;

    save_home)
        lat=$(p_str lat); lon=$(p_str lon)
        valid_coord "$lat" "$lon" || { cgi_error "invalid_coord" "lat/lon out of range"; exit 0; }
        conf_write '.home = {lat: ($a|tonumber), lon: ($o|tonumber)}' --arg a "$lat" --arg o "$lon" \
            || { cgi_error "write_failed" "Could not save"; exit 0; }
        cgi_success
        ;;

    clear_home)
        conf_write 'del(.home)' || { cgi_error "write_failed" "Could not save"; exit 0; }
        cgi_success
        ;;

    set_override)
        key=$(p_str key); lat=$(p_str lat); lon=$(p_str lon)
        valid_key "$key" || { cgi_error "invalid_key" "key must be <mcc>-<mnc>-<enb>"; exit 0; }
        valid_coord "$lat" "$lon" || { cgi_error "invalid_coord" "lat/lon out of range"; exit 0; }
        n=$(conf_json | jq -r '(.overrides // {}) | length')
        if [ "${n:-0}" -ge 500 ] && [ "$(conf_json | jq -r --arg k "$key" '(.overrides // {}) | has($k)')" != "true" ]; then
            cgi_error "too_many" "At most 500 tower corrections can be saved"; exit 0
        fi
        conf_write '.overrides = ((.overrides // {}) + {($k): {lat: ($a|tonumber), lon: ($o|tonumber)}})' \
            --arg k "$key" --arg a "$lat" --arg o "$lon" || { cgi_error "write_failed" "Could not save"; exit 0; }
        cgi_success
        ;;

    clear_override)
        key=$(p_str key)
        valid_key "$key" || { cgi_error "invalid_key" "key must be <mcc>-<mnc>-<enb>"; exit 0; }
        conf_write '.overrides = ((.overrides // {}) | del(.[$k]))' --arg k "$key" \
            || { cgi_error "write_failed" "Could not save"; exit 0; }
        cgi_success
        ;;

    *)
        cgi_error "unknown_action" "Unknown action"
        ;;
esac
exit 0

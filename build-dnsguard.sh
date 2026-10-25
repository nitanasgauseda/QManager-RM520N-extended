#!/bin/sh
# Cross-compile qmanager_dnsguard (DNS Privacy forwarder) for the modem (ARMv7l, Linux). Standard library only.
set -eu

OUT="qmanager-build/bin/qmanager_dnsguard"
mkdir -p qmanager-build/bin
GO_EXE="${GO_EXE:-go}"

# The forwarder embeds its trust roots (dnsguard/main.go: //go:embed cacert.pem); the modem has no
# CA bundle of its own. The file is gitignored (*.pem), so every build fetches a current copy:
#   DNSGUARD_CA_BUNDLE=<file>  use this bundle as is;
#   otherwise Mozilla's bundle from curl.se, checked against its published sha256;
#   otherwise Python certifi's copy of it; never the build host's system bundle.
CA_OUT="dnsguard/cacert.pem"
CA_URL="https://curl.se/ca/cacert.pem"
ca_ok() { [ -s "$1" ] && [ "$(grep -c 'BEGIN CERTIFICATE' "$1" 2>/dev/null)" -ge 50 ]; }
ca_fetch() {
    command -v curl >/dev/null 2>&1 || return 1
    curl -fsSL --max-time 60 -o "$CA_OUT.new" "$CA_URL" || return 1
    want=$(curl -fsSL --max-time 30 "$CA_URL.sha256" | awk '{print $1}') || return 1
    if command -v sha256sum >/dev/null 2>&1; then
        got=$(sha256sum "$CA_OUT.new" | awk '{print $1}')
    else
        got=$(shasum -a 256 "$CA_OUT.new" | awk '{print $1}')
    fi
    [ -n "$want" ] && [ "$got" = "$want" ] || { echo "WARN: $CA_URL failed its sha256 check" >&2; return 1; }
    ca_ok "$CA_OUT.new" && mv -f "$CA_OUT.new" "$CA_OUT"
}
rm -f "$CA_OUT.new"
if [ -n "${DNSGUARD_CA_BUNDLE:-}" ]; then
    ca_ok "$DNSGUARD_CA_BUNDLE" || { echo "ERROR: DNSGUARD_CA_BUNDLE=$DNSGUARD_CA_BUNDLE is not a CA bundle" >&2; exit 1; }
    cp "$DNSGUARD_CA_BUNDLE" "$CA_OUT"
elif ca_fetch; then
    echo "CA bundle: $CA_URL (sha256 verified)"
else
    rm -f "$CA_OUT.new"
    # Never the build host's system bundle: behind a TLS-inspecting proxy or in CI it carries extra
    # CAs (it did: an egress proxy's interception CA), which the forwarder would then trust.
    f=$(python3 -I -c 'import certifi; print(certifi.where())' 2>/dev/null)
    if [ -n "$f" ] && ca_ok "$f"; then
        cp "$f" "$CA_OUT"; echo "CA bundle: $f (python certifi)"
    else
        echo "ERROR: no CA bundle. Set DNSGUARD_CA_BUNDLE to Mozilla's cacert.pem (https://curl.se/ca/cacert.pem)." >&2
        exit 1
    fi
fi
ca_ok "$CA_OUT" || { echo "ERROR: no CA bundle for $CA_OUT; set DNSGUARD_CA_BUNDLE" >&2; exit 1; }

echo "Building qmanager_dnsguard for linux/arm7 (go: $GO_EXE)..."
cd dnsguard
env GOOS=linux GOARCH=arm GOARM=7 CGO_ENABLED=0 "$GO_EXE" build \
    -trimpath -buildvcs=false \
    -ldflags="-s -w -buildid=" \
    -o "../${OUT}" .
cd ..

case "$(head -c 4 "${OUT}" | od -An -c 2>/dev/null | tr -d ' \n')" in
    *ELF*) ;;
    *) echo "ERROR: ${OUT} is not an ELF binary" >&2; exit 1 ;;
esac
echo "Built: ${OUT} ($(du -sh "$OUT" | cut -f1))"

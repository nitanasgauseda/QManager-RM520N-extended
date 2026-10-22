#!/bin/sh
# Cross-compile qmanager_dnsguard (DNS Privacy forwarder) for the modem (ARMv7l, Linux). Standard library only.
set -eu

OUT="qmanager-build/bin/qmanager_dnsguard"
mkdir -p qmanager-build/bin
GO_EXE="${GO_EXE:-go}"

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

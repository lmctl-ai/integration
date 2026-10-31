#!/usr/bin/env bash
# Self-test for actions/setup scripts with a fake gh (no network) plus real npm for the lmctl tag controls.
# Every control below is a deliberate break that must make the script fail; a pass without the failure is a bug.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }

tmp=$(mktemp -d)
export INTEGRATION_TEMP="$tmp/scratch" INTEGRATION_BIN="$tmp/bin" FAKE_RELEASES="$tmp/releases"
export INTEGRATION_OS=linux INTEGRATION_ARCH=x64
mkdir -p "$INTEGRATION_TEMP" "$FAKE_RELEASES/lmctl-ai__demo/v1.0.0"
mkdir -p "$tmp/fakebin"; cp "$here/fake-gh" "$tmp/fakebin/gh"
export PATH="$tmp/fakebin:$PATH"

rel="$FAKE_RELEASES/lmctl-ai__demo/v1.0.0"
printf '#!/bin/sh\necho demo 1.0.0\n' > "$rel/demo-linux-x64"
printf 'extra-content\n' > "$rel/extra.txt"
echo v1.0.0 > "$FAKE_RELEASES/lmctl-ai__demo/LATEST"
sum() { (cd "$rel" && sha256sum demo-linux-x64 extra.txt > SHA256SUMS); }
sum

# 1. good download installs an executable and keeps the verified extra asset
out=$(bash "$repo/actions/setup/fetch-host.sh" demo@v1.0.0+extra.txt 2>&1); rc=$?
if [ $rc -eq 0 ] && [ -x "$INTEGRATION_BIN/demo" ] && [ "$("$INTEGRATION_BIN/demo")" = "demo 1.0.0" ] && [ -f "$INTEGRATION_TEMP/assets/demo/extra.txt" ]; then ok "verified download installs host and extra asset"; else bad "verified download ($rc): $out"; fi

# 2. latest resolves through the release listing
rm -rf "$INTEGRATION_BIN"; out=$(bash "$repo/actions/setup/fetch-host.sh" demo 2>&1); rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q 'resolved=v1.0.0'; then ok "latest resolves to the newest tag"; else bad "latest ($rc): $out"; fi

# 3. CONTROL wrong checksum must fail, name the file and install nothing
rm -rf "$INTEGRATION_BIN"
sed -i '1s/^./0/' "$rel/SHA256SUMS"
out=$(bash "$repo/actions/setup/fetch-host.sh" demo@v1.0.0 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'checksum mismatch for demo-linux-x64' && [ ! -e "$INTEGRATION_BIN/demo" ]; then ok "control: corrupted SHA256SUMS fails before install"; else bad "corrupted SHA256SUMS accepted ($rc): $out"; fi
sum

# 4. CONTROL a bad checksum of an extra asset must fail too
sed -i '2s/^./0/' "$rel/SHA256SUMS"
out=$(bash "$repo/actions/setup/fetch-host.sh" demo@v1.0.0+extra.txt 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'checksum mismatch for extra.txt'; then ok "control: corrupted extra asset checksum fails"; else bad "extra asset checksum accepted ($rc): $out"; fi
sum

# 5. CONTROL unknown tag fails with the tag in the message
out=$(bash "$repo/actions/setup/fetch-host.sh" demo@v9.9.9 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'v9.9.9'; then ok "control: unknown host tag fails naming the tag"; else bad "unknown host tag ($rc): $out"; fi

# 6. CONTROL a missing SHA256SUMS entry must fail
grep -v 'demo-linux-x64' "$rel/SHA256SUMS" > "$rel/S2" && mv "$rel/S2" "$rel/SHA256SUMS"
out=$(bash "$repo/actions/setup/fetch-host.sh" demo@v1.0.0 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'no entry'; then ok "control: asset without a checksum entry fails"; else bad "missing checksum entry accepted ($rc): $out"; fi
sum

# 7. platform naming: windows gets .exe, macOS arm64 gets macos-arm64
(. "$repo/actions/setup/lib.sh"; INTEGRATION_OS=windows INTEGRATION_ARCH=x64 asset_name demo) | grep -qx 'demo-windows-x64.exe' && ok "asset name windows" || bad "asset name windows"
(. "$repo/actions/setup/lib.sh"; INTEGRATION_OS=macos INTEGRATION_ARCH=arm64 asset_name demo) | grep -qx 'demo-macos-arm64' && ok "asset name macos arm64" || bad "asset name macos arm64"

# 8. CONTROL lmctl tags: garbage and unknown versions fail with the tag in the message (real npm for the unknown one)
out=$(bash "$repo/actions/setup/install-lmctl.sh" 'not a tag' 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "not a tag"; then ok "control: malformed lmctl tag fails naming it"; else bad "malformed lmctl tag ($rc): $out"; fi
if [ "${SELFTEST_OFFLINE:-}" != 1 ]; then
  out=$(bash "$repo/actions/setup/install-lmctl.sh" 0.0.1-does-not-exist 2>&1); rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -q '0.0.1-does-not-exist'; then ok "control: unknown lmctl version fails naming it"; else bad "unknown lmctl version ($rc): $out"; fi
fi

# 9. miniplayer pin must be a full commit sha
out=$(bash "$repo/actions/setup/install-miniplayer.sh" main 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "40-hex"; then ok "control: moving miniplayer ref refused"; else bad "miniplayer branch ref accepted ($rc): $out"; fi

rm -rf "$tmp"
if [ $fails -ne 0 ]; then echo "$fails selftest failure(s)"; exit 1; fi
echo "setup selftest OK"

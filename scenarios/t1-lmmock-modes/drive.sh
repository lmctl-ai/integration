#!/usr/bin/env bash
# Runs inside `lmmock exec`. usage: drive.sh seed | drive.sh MODE STATUS CLASS COUNT
set -euo pipefail
cd "$(dirname "$0")"
: "${LMMOCK_URL:?LMMOCK_URL is unset: drive.sh must run under lmmock exec}"
export MINIPLAYER_CATALOG="$PWD/catalog.json" OPENAI_API_KEY=fixture-key MINIPLAYER_CONFIG="$PWD/miniplayer.json"
printf '{"provider":{"openai":{"baseURL":"%s/v1"}}}' "$LMMOCK_URL" > "$MINIPLAYER_CONFIG"
if [ "$1" = seed ]; then
  lmctl --non-interactive seed team.lmctl >/dev/null
  exit 0
fi
mode=$1 status=$2 class=$3 count=$4
rc=0
out=$(lmscript --no-preflight run.lms "$mode" "$status" "$class" 2>&1) || rc=$?
echo "$out" | grep -E '^(PASS|FAIL|got:)' || true
served=$(curl -fsS "$LMMOCK_URL/__requests" | sed -n 's/.*"count":\([0-9]*\).*/\1/p')
echo "requests served by the mock: $served (expected $count)"
[ "$rc" -eq 0 ] || { echo "FAIL case $mode: script exited $rc"; echo "$out" | tail -8; exit 1; }
[ "$served" = "$count" ] || { echo "FAIL case $mode: mock served $served requests, expected $count"; exit 1; }

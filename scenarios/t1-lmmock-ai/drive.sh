#!/usr/bin/env bash
# Runs inside `lmmock exec`: LMMOCK_URL is the mock base URL.
set -euo pipefail
cd "$(dirname "$0")"
: "${LMMOCK_URL:?LMMOCK_URL is unset: drive.sh must run under lmmock exec}"
# miniplayer reaches the mock only through this base URL. Without it miniplayer would silently use the
# vendor endpoint, so the positive assertion below (the mock saw the request) is part of the scenario.
export MINIPLAYER_CATALOG="$PWD/catalog.json" OPENAI_API_KEY=fixture-key MINIPLAYER_CONFIG="$PWD/miniplayer.json"
# Control only: an unreachable base URL must turn the scenario red.
if [ "${INTEGRATION_CONTROL_NO_BASEURL:-}" = 1 ]; then
  printf '{"provider":{"openai":{"baseURL":"http://127.0.0.1:1/v1"}}}' > "$MINIPLAYER_CONFIG"
else
  printf '{"provider":{"openai":{"baseURL":"%s/v1"}}}' "$LMMOCK_URL" > "$MINIPLAYER_CONFIG"
fi
lmctl --non-interactive seed team.lmctl >/dev/null
rc=0
lmscript --no-preflight run.lms || rc=$?
# Print what the mock saw even when the script failed: it is the evidence for the cause.
seen=$(curl -fsS "$LMMOCK_URL/__inspect" || true)
echo "inspect: $seen"
[ "$rc" -eq 0 ] || exit "$rc"
# The mock itself must have seen a chat request for model mock-agent.
printf '%s' "$seen" | grep -q 'mock-agent' || { echo "FAIL: lmmock did not see a request for model mock-agent"; exit 1; }
echo "T1 mock saw the request"

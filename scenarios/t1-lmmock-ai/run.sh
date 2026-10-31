#!/usr/bin/env bash
# T1: published lmscript -> lmctl -> miniplayer (ACP) -> HTTP -> lmmock llm-api server.
# lmmock owns the mock lifetime: `lmmock exec` binds 127.0.0.1:0, exports LMMOCK_URL, runs drive.sh and
# propagates its exit code. No background process and no fixed port.
set -euo pipefail
cd "$(dirname "$0")"
: "${INTEGRATION_ASSETS_LMMOCK:?INTEGRATION_ASSETS_LMMOCK is unset: install lmmock with the examples.tar.gz extra asset}"
examples=$(mktemp -d)
tar xzf "$INTEGRATION_ASSETS_LMMOCK/examples.tar.gz" -C "$examples"
lmmock --version
lmctl --version
exec lmmock exec --script "$examples/examples/llm-api.lms" -- bash "$PWD/drive.sh"

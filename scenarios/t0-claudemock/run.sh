#!/usr/bin/env bash
# T0: published lmscript lm_prompt against the in-process ClaudeMock provider. No network, no lmmock.
set -euo pipefail
cd "$(dirname "$0")"
export LMCTL_ENABLE_MOCK_PROVIDER=1 LMCTL_CLAUDE_MOCK_STORE="$PWD/store.json"
lmctl --version
lmctl --non-interactive seed team.lmctl >/dev/null
lmscript --no-preflight run.lms

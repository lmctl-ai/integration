#!/usr/bin/env bash
# T0: the shape of lmctl-test provider-smoke.mjs (fresh seeded agent, ping, three-turn memory conversation) against the
# ClaudeMock provider instead of a live vendor. It proves seed, ordered turns and result plumbing; it cannot prove a
# vendor remembers anything (that stays with the live oracle).
set -euo pipefail
cd "$(dirname "$0")"
export LMCTL_ENABLE_MOCK_PROVIDER=1 LMCTL_CLAUDE_MOCK_STORE="$PWD/store.json"
lmctl --non-interactive seed team.lmctl >/dev/null
lmscript --no-preflight run.lms

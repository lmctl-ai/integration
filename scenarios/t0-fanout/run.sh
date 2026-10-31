#!/usr/bin/env bash
# T0: lm_fanout over three ClaudeMock members with mixed outcomes; slot order must be preserved.
# Ported intent: lmctl-test merged-api "ordered lm_fanout" and the ok-but-empty rule, against published lmctl.
set -euo pipefail
cd "$(dirname "$0")"
export LMCTL_ENABLE_MOCK_PROVIDER=1 LMCTL_CLAUDE_MOCK_STORE="$PWD/store.json"
mkdir -p a b c
# One session directory per member: ClaudeMock derives its session id from the cwd, so members that share a
# directory collide ("sessionid ownership conflict").
printf '_MEMBER_ alias=A provider=ClaudeMock model=claude-mock sessiondir=%s/a\n_MEMBER_ alias=B provider=ClaudeMock model=claude-mock sessiondir=%s/b\n_MEMBER_ alias=C provider=ClaudeMock model=claude-mock sessiondir=%s/c\n' "$PWD" "$PWD" "$PWD" > team.lmctl
lmctl --non-interactive seed team.lmctl >/dev/null
lmscript --no-preflight run.lms

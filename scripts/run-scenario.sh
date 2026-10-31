#!/usr/bin/env bash
# Run one scenario directory: copy it into a fresh workdir (scenarios write session state), then execute its
# run.sh under hermetic.sh. Exit code is run.sh's. usage: run-scenario.sh scenarios/<tier>/<name>
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
src=${1:?usage: run-scenario.sh SCENARIO_DIR}
[ -f "$src/run.sh" ] || { echo "run-scenario.sh: $src has no run.sh" >&2; exit 2; }
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/scenario.XXXXXX")
cp -R "$src" "$work/scenario"
echo "== scenario $src (workdir $work)"
exec bash "$here/hermetic.sh" "$work" -- bash "$work/scenario/run.sh"

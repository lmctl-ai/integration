#!/usr/bin/env bash
# Run every scenario directory of the given tiers (default: t0 t1), keep going after a failure, fail at the end.
# usage: run-all-scenarios.sh [tier-prefix...]   e.g. t0   or   t0 t1
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
tiers=("$@"); [ "${#tiers[@]}" -gt 0 ] || tiers=(t0 t1)
failed=()
for tier in "${tiers[@]}"; do
  for dir in "$repo"/scenarios/"$tier"-*/; do
    [ -f "$dir/run.sh" ] || continue
    name=$(basename "$dir")
    echo "::group::scenario $name"
    if bash "$here/run-scenario.sh" "$dir"; then echo "scenario $name: PASS"; else echo "scenario $name: FAIL"; failed+=("$name"); fi
    echo "::endgroup::"
  done
done
if [ "${#failed[@]}" -gt 0 ]; then echo "FAILED scenarios: ${failed[*]}"; exit 1; fi
echo "all selected scenarios passed"

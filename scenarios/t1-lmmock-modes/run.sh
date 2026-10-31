#!/usr/bin/env bash
# T1: lmscript -> lmctl -> miniplayer (ACP) -> HTTP -> lmmock llm-api, one `lmmock exec` per failure mode.
# Seeds once under mode ok, then runs every row of cases.tsv. Fails on the first row that disagrees.
set -euo pipefail
cd "$(dirname "$0")"
: "${INTEGRATION_ASSETS_LMMOCK:?INTEGRATION_ASSETS_LMMOCK is unset: install lmmock with the examples.tar.gz extra asset}"
examples=$(mktemp -d)
tar xzf "$INTEGRATION_ASSETS_LMMOCK/examples.tar.gz" -C "$examples"
lmmock --version
lmctl --version
script="$examples/examples/llm-api.lms"
run_case() { # mode status class count
  printf '{"apiKey":"fixture-key","mode":"%s"}' "$1" > "cfg-$1.json"
  echo "== case $1"
  lmmock exec --script "$script" --config "$PWD/cfg-$1.json" -- bash "$PWD/drive.sh" "$@"
}
# seed under mode ok (the seed turn is a real request)
printf '{"apiKey":"fixture-key","mode":"ok"}' > cfg-seed.json
lmmock exec --script "$script" --config "$PWD/cfg-seed.json" -- bash "$PWD/drive.sh" seed
while read -r mode status class count; do
  case "$mode" in ''|\#*) continue ;; esac
  run_case "$mode" "$status" "$class" "$count"
done < cases.tsv
echo "T1 modes OK"

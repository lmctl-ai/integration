#!/usr/bin/env bash
# Re-vendor the ported tiers of lmctlhq/lmctl-mono-test (read-only clone) into this tree.
# usage: vendor.sh PATH_TO_CLONE      Files whose inventory.tsv class starts with skip- are not copied.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=${1:?usage: vendor.sh PATH_TO_CLONE_OF_lmctl-mono-test}
[ -d "$src/lmctl-test/tests" ] || { echo "no lmctl-test/tests under $src" >&2; exit 2; }
sha=$(git -C "$src" rev-parse --short HEAD)
rm -rf "$here/lmctl-test"; mkdir -p "$here/lmctl-test/tests"
cp "$src/live-config.mjs" "$src/live-config.json" "$here/"
cp "$src/lmctl-test/VERSION" "$here/lmctl-test/"
echo '{"type":"module"}' > "$here/lmctl-test/package.json"
missing=0
for entry in "$src"/lmctl-test/tests/*; do
  name=$(basename "$entry")
  class=$(awk -F'\t' -v n="$name" '$1==n {print $2}' "$here/inventory.tsv")
  if [ -z "$class" ]; then echo "inventory.tsv has no row for $name" >&2; missing=1; continue; fi
  case "$class" in skip-*) continue ;; esac
  cp -R "$entry" "$here/lmctl-test/tests/"
done
[ "$missing" -eq 0 ] || exit 1
echo "vendored from lmctl-mono-test@$sha"

# Portability patches (the only edits to vendored files). Each must match, so a changed upstream fails loudly.
node_re='/home/mma/\.nvm/versions/node/v24\.18\.0/bin'
patch() { # FILE SED_EXPR EXPECTED_COUNT_OF_CHANGED_LINES
  local f="$here/lmctl-test/tests/$1" before after
  before=$(cat "$f"); sed -i -E "$2" "$f"; after=$(cat "$f")
  [ "$before" != "$after" ] || { echo "patch did not apply to $1: $2" >&2; exit 1; }
}
for f in command-literals native-git schema-import pref-overlay schema-nocap; do
  patch "$f.lms" "s#^NODE_BIN = \"$node_re/node\";#NODE_BIN = env(\"NODE_BIN\", \"node\");#"
done
patch schema-import.lms "s#\"$node_re:\"#env(\"NODE_DIR\", \"/usr/bin\") + \":\"#"
patch schema-nocap.lms "s#\"$node_re:\"#env(\"NODE_DIR\", \"/usr/bin\") + \":\"#"
patch schema-import.lms "s#\"PATH=$node_re\"#\"PATH=\" + env(\"NODE_DIR\", \"/usr/bin\")#"
patch schema-import.lms "s#env PATH=\\.:$node_re \" \\+ LMSCRIPT_BIN#env PATH=.:\" + env(\"NODE_DIR\", \"/usr/bin\") + \" \" + LMSCRIPT_BIN#"
patch native-git.lms "s#\"  env: \\{PATH: '$node_re', HOME: '/tmp'\\},\\\\n\" \\+#\"  env: {PATH: '\" + env(\"NODE_DIR\", \"/usr/bin\") + \"', HOME: '/tmp'},\\\\n\" +#"
echo "patched node paths (NODE_BIN / NODE_DIR from the environment)"
# failure-detection.mjs also injects a fault into doc-examples.lms, which needs the language docs of a mono source checkout
# (skip-host); that pair is dropped so the controls after it still run.
patch failure-detection.mjs "s#, \\['doc-examples', 'IT_MUTATE_DOC_EXAMPLES'\\]##"
echo "patched failure-detection (doc-examples control dropped)"

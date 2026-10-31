#!/usr/bin/env bash
# miniplayer has no release yet (operator decision D2 is pending): build it from a pinned commit of
# lmctl-ai/miniplayer and expose a `miniplayer` command. Replace this by fetch-host.sh once it publishes.
# usage: install-miniplayer.sh COMMIT_SHA   (a full 40-hex commit; branch names are refused: the pin must not move)
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/lib.sh"

ref=${1:?usage: install-miniplayer.sh COMMIT_SHA}
printf '%s' "$ref" | grep -Eq '^[0-9a-f]{40}$' || die "miniplayer ref '$ref' must be a full 40-hex commit sha"
url=${MINIPLAYER_URL:-https://github.com/lmctl-ai/miniplayer.git}
root=$(scratch_root)
src="$root/miniplayer-$ref"
rm -rf "$src"; mkdir -p "$src"
git -C "$src" init -q
git -C "$src" remote add origin "$url"
retry_download 3 git -C "$src" fetch -q --depth 1 origin "$ref" || die "cannot fetch miniplayer commit $ref from $url"
git -C "$src" checkout -q FETCH_HEAD
head=$(git -C "$src" rev-parse HEAD)
[ "$head" = "$ref" ] || die "miniplayer checkout is $head, expected $ref"
retry_download 3 npm ci --omit=dev --prefix "$src" --no-audit --no-fund --loglevel=error || die "npm ci of miniplayer failed"

bin="${INTEGRATION_BIN:-$root/integration-bin}"
mkdir -p "$bin"
printf '#!/usr/bin/env bash\nexec node "%s/bin/miniplayer.js" "$@"\n' "$src" > "$bin/miniplayer"
chmod +x "$bin/miniplayer"
add_path "$bin"
# Suites that want the JS entry itself (mono-test miniplayer-tools) read this.
if [ -n "${GITHUB_ENV:-}" ]; then echo "INTEGRATION_MINIPLAYER_JS=$src/bin/miniplayer.js" >> "$GITHUB_ENV"; fi
set_output miniplayer-js "$src/bin/miniplayer.js"
note "miniplayer commit=$ref (built from source, no release exists)"
set_output miniplayer-version "$ref"

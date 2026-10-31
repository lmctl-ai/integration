#!/usr/bin/env bash
# Install a PUBLISHED lmctl (npm @lmctl-ai/lmctl) into a private prefix. No global install, no ~/.lmctl.
# usage: install-lmctl.sh latest|staging|X.Y.Z
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/lib.sh"

tag=${1:-latest}
case "$tag" in
  latest|staging) ;;
  *) if ! printf '%s' "$tag" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
       die "lmctl tag '$tag' is not latest, staging or X.Y.Z"
     fi ;;
esac

version=$(npm view "@lmctl-ai/lmctl@$tag" version 2>/dev/null | tail -1 || true)
if [ -z "$version" ]; then
  die "lmctl tag '$tag' does not resolve on npm (dist-tags: $(npm view @lmctl-ai/lmctl dist-tags --json 2>/dev/null | tr -d '\n ' || echo unavailable))"
fi

prefix="$(scratch_root)/lmctl-$version"
retry_download 3 npm install --prefix "$prefix" "@lmctl-ai/lmctl@$version" --no-audit --no-fund --loglevel=error \
  || die "npm install of @lmctl-ai/lmctl@$version failed"
bin="$prefix/node_modules/.bin"
[ -e "$bin/lmctl" ] || die "installed @lmctl-ai/lmctl@$version has no lmctl binary in $bin"
add_path "$bin"
got=$("$bin/lmctl" --version 2>&1 | head -1)
note "lmctl requested=$tag resolved=$version binary='$got' prefix=$prefix"
set_output lmctl-version "$version"
set_output lmctl-bin "$bin"

#!/usr/bin/env bash
# Download a release asset of a lmctl-ai host and verify it against the release SHA256SUMS before installing it.
# usage: fetch-host.sh NAME[@TAG][+EXTRA_ASSET...]
#   TAG: vX.Y.Z or latest (default latest); repo lmctl-ai/NAME unless HOST_REPO is set.
#   EXTRA_ASSET: more release files (for example examples.tar.gz) verified the same way and kept, not installed;
#   their directory is exported as INTEGRATION_ASSETS_<NAME> (upper case, dashes to underscores).
# Needs: gh (GH_TOKEN), sha256sum or shasum. Hosts use NAME-{linux,macos}-{x64,arm64} / NAME-windows-x64.exe.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/lib.sh"

spec=${1:?usage: fetch-host.sh NAME[@TAG][+EXTRA_ASSET...]}
extras=()
rest=$spec
if [ "${spec#*+}" != "$spec" ]; then
  rest=${spec%%+*}
  IFS='+' read -r -a extras <<< "${spec#*+}"
fi
name=${rest%%@*}
tag=latest
if [ "$name" != "$rest" ]; then tag=${rest#*@}; fi
printf '%s' "$name" | grep -Eq '^[a-z][a-z0-9-]*$' || die "host name '$name' is not a lowercase name"
repo=${HOST_REPO:-lmctl-ai/$name}

if [ "$tag" = latest ] || [ -z "$tag" ]; then
  tag=$(gh release view --repo "$repo" --json tagName --jq .tagName 2>/dev/null || true)
  [ -n "$tag" ] || die "no latest release found for $repo"
fi

asset=$(asset_name "$name")
root=$(scratch_root)
dl="$root/dl-$name-$tag"
rm -rf "$dl"; mkdir -p "$dl"
patterns=(-p "$asset" -p SHA256SUMS)
for extra in "${extras[@]+"${extras[@]}"}"; do patterns+=(-p "$extra"); done
retry_download 3 gh release download "$tag" --repo "$repo" "${patterns[@]}" -D "$dl" --clobber \
  || die "release tag '$tag' of $repo has no downloadable asset '$asset' and SHA256SUMS"
[ -f "$dl/$asset" ] || die "release $repo@$tag has no asset '$asset'"
[ -f "$dl/SHA256SUMS" ] || die "release $repo@$tag has no SHA256SUMS"

verify() { # FILE_NAME -> prints the verified sha256
  local f=$1 want got
  [ -f "$dl/$f" ] || die "release $repo@$tag has no asset '$f'"
  want=$(awk -v a="$f" '{n=$2; sub(/^\*/,"",n); if (n==a) {print $1; exit}}' "$dl/SHA256SUMS")
  [ -n "$want" ] || die "SHA256SUMS of $repo@$tag has no entry for '$f'"
  got=$(sha256_of "$dl/$f")
  if [ "$want" != "$got" ]; then
    die "checksum mismatch for $f of $repo@$tag: SHA256SUMS says $want, downloaded file is $got"
  fi
  echo "$got"
}
got=$(verify "$asset")
keep="$root/assets/$name"
for extra in "${extras[@]+"${extras[@]}"}"; do
  verify "$extra" >/dev/null
  mkdir -p "$keep"; cp "$dl/$extra" "$keep/$extra"
done
if [ "${#extras[@]}" -gt 0 ]; then
  var="INTEGRATION_ASSETS_$(printf '%s' "$name" | tr 'a-z-' 'A-Z_')"
  if [ -n "${GITHUB_ENV:-}" ]; then echo "$var=$keep" >> "$GITHUB_ENV"; fi
  set_output "$name-assets" "$keep"
  note "$name extra assets verified: ${extras[*]} in $keep ($var)"
fi

bin="${INTEGRATION_BIN:-$root/integration-bin}"
mkdir -p "$bin"
dest="$bin/$name"; if [ "$(platform_os)" = windows ]; then dest="$bin/$name.exe"; fi
cp "$dl/$asset" "$dest"; chmod +x "$dest"
add_path "$bin"
note "$name requested=$spec resolved=$tag asset=$asset sha256=$got"
set_output "$name-version" "$tag"
set_output "$name-sha256" "$got"

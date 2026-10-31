#!/usr/bin/env bash
# Build the job matrix from CSV inputs (LMCTL, LMMOCK) and versions.lock. Writes step outputs.
# The word "pinned" in LMCTL/LMMOCK is replaced by the matching versions.lock pin.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
lock="$here/../versions.lock"
get() { grep -E "^$1=" "$lock" | head -1 | cut -d= -f2-; }
pinned_lmctl=$(get LMCTL); pinned_lmmock=$(get LMMOCK); miniplayer=$(get MINIPLAYER); node=$(get NODE)
[ -n "$pinned_lmctl" ] && [ -n "$pinned_lmmock" ] && [ -n "$miniplayer" ] && [ -n "$node" ] || { echo "versions.lock lacks LMCTL, LMMOCK, MINIPLAYER or NODE" >&2; exit 1; }
lmctl_csv=${LMCTL:-pinned,latest,staging}; [ -n "$lmctl_csv" ] || lmctl_csv=pinned,latest,staging
lmmock_csv=${LMMOCK:-pinned,latest}; [ -n "$lmmock_csv" ] || lmmock_csv=pinned,latest
lmctl_csv=${lmctl_csv//pinned/$pinned_lmctl}
lmmock_csv=${lmmock_csv//pinned/$pinned_lmmock}
matrix=$(node -e '
const split = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
const lmctl = split(process.argv[1]), lmmock = split(process.argv[2]);
const ok = /^(latest|staging|v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)$/;
for (const t of [...lmctl, ...lmmock]) if (!ok.test(t)) { console.error("bad tag: " + t); process.exit(1); }
console.log(JSON.stringify({ include: lmctl.flatMap((a) => lmmock.map((b) => ({ lmctl: a, lmmock: b }))) }));
' "$lmctl_csv" "$lmmock_csv")
echo "matrix=$matrix"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  { echo "matrix=$matrix"; echo "miniplayer=$miniplayer"; echo "node=$node"; } >> "$GITHUB_OUTPUT"
fi

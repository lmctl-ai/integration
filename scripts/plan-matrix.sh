#!/usr/bin/env bash
# Build the job matrix from CSV inputs (LMCTL, LMMOCK) and versions.lock. Writes step outputs.
# The word "pinned" in LMMOCK is replaced by the LMMOCK pin of versions.lock.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
lock="$here/../versions.lock"
get() { grep -E "^$1=" "$lock" | head -1 | cut -d= -f2-; }
pinned=$(get LMMOCK); miniplayer=$(get MINIPLAYER); node=$(get NODE)
[ -n "$pinned" ] && [ -n "$miniplayer" ] && [ -n "$node" ] || { echo "versions.lock lacks LMMOCK, MINIPLAYER or NODE" >&2; exit 1; }
lmctl_csv=${LMCTL:-latest,staging}; [ -n "$lmctl_csv" ] || lmctl_csv=latest,staging
lmmock_csv=${LMMOCK:-pinned,latest}; [ -n "$lmmock_csv" ] || lmmock_csv=pinned,latest
lmmock_csv=${lmmock_csv//pinned/$pinned}
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

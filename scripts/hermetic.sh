#!/usr/bin/env bash
# Run a command with a private HOME, lmctl database and cache, and without the lmctl session markers of
# an enclosing lmctl session. Inside a session LMCTL_SELF_SESSIONID makes every lm_prompt fail with
# self_session_unregistered, so a scenario that omits this scrub is not reproducible from an agent shell.
# usage: hermetic.sh WORKDIR -- COMMAND [ARG...]
# INTEGRATION_NO_SCRUB=1 keeps the inherited session variables. It exists only for tests/scrub-control.sh.
set -euo pipefail
work=${1:?usage: hermetic.sh WORKDIR -- COMMAND [ARG...]}
shift
[ "${1:-}" = "--" ] || { echo "hermetic.sh: expected -- after WORKDIR" >&2; exit 2; }
shift
[ "$#" -gt 0 ] || { echo "hermetic.sh: no command" >&2; exit 2; }
mkdir -p "$work/home" "$work/cache"
unset_args=()
if [ "${INTEGRATION_NO_SCRUB:-}" != 1 ]; then
  unset_args=(-u LMCTL_SELF_SESSIONID -u LMCTL_SELF_ALIAS -u LMCTL_TEAMFILE -u LMCTL_INVOCATION_ID -u LMCTL_LAUNCH_SOURCE)
fi
exec env "${unset_args[@]}" HOME="$work/home" XDG_CACHE_HOME="$work/cache" LMCTL_DB="$work/home/lmctl.db" "$@"

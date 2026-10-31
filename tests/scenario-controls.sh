#!/usr/bin/env bash
# Failing controls for the scenarios: each deliberate break must turn the scenario red.
# Needs published lmctl on PATH (setup action). T1 controls also need lmmock, miniplayer and INTEGRATION_ASSETS_LMMOCK.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
tmp=$(mktemp -d)
export RUNNER_TEMP=$tmp

# A. T0 baseline passes, so the controls below prove something.
out=$(bash "$repo/scripts/run-scenario.sh" "$repo/scenarios/t0-claudemock" 2>&1); rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q 'T0 OK'; then ok "T0 baseline is green"; else bad "T0 baseline ($rc): $out"; fi

# B. CONTROL: a wrong expectation (pong -> pang) turns T0 red.
cp -R "$repo/scenarios/t0-claudemock" "$tmp/t0-pang"
sed -i 's/ok.reply == "pong"/ok.reply == "pang"/' "$tmp/t0-pang/run.lms"
out=$(bash "$repo/scripts/run-scenario.sh" "$tmp/t0-pang" 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'FAIL ok reply'; then ok "control: wrong expectation turns T0 red"; else bad "wrong expectation stayed green ($rc): $out"; fi

# C. CONTROL: a script that trusts status ok alone would miss the empty reply. Our scenario asserts the empty
#    reply explicitly; replacing the store answer by a non-empty one must therefore turn T0 red.
cp -R "$repo/scenarios/t0-claudemock" "$tmp/t0-nonempty"
sed -i 's/"empty please": ""/"empty please": "not empty"/' "$tmp/t0-nonempty/store.json"
out=$(bash "$repo/scripts/run-scenario.sh" "$tmp/t0-nonempty" 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'FAIL empty reply is detectable'; then ok "control: empty reply case goes red when the mock stops returning empty"; else bad "empty-reply control stayed green ($rc): $out"; fi

# D. Scrub: with a session marker exported, the scrubbed run stays green and the unscrubbed run fails.
out=$(LMCTL_SELF_SESSIONID=bogus-session LMCTL_SELF_ALIAS=Bogus bash "$repo/scripts/run-scenario.sh" "$repo/scenarios/t0-claudemock" 2>&1); rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q 'T0 OK'; then ok "scrub: T0 green with LMCTL_SELF_SESSIONID exported"; else bad "scrubbed run with session marker ($rc): $out"; fi
out=$(INTEGRATION_NO_SCRUB=1 LMCTL_SELF_SESSIONID=bogus-session LMCTL_SELF_ALIAS=Bogus bash "$repo/scripts/run-scenario.sh" "$repo/scenarios/t0-claudemock" 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -Eqi 'self_session_unregistered|LMCTL_SELF_SESSIONID is set'; then ok "control: omitting the scrub fails with self_session_unregistered"; else bad "unscrubbed run did not fail with self_session_unregistered ($rc): $out"; fi

# E. T1 (only when its tools are installed)
if [ -n "${INTEGRATION_ASSETS_LMMOCK:-}" ] && command -v lmmock >/dev/null && command -v miniplayer >/dev/null; then
  out=$(bash "$repo/scripts/run-scenario.sh" "$repo/scenarios/t1-lmmock-ai" 2>&1); rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q 'T1 mock saw the request'; then ok "T1 baseline is green"; else bad "T1 baseline ($rc): $out"; fi
  out=$(INTEGRATION_CONTROL_NO_BASEURL=1 bash "$repo/scripts/run-scenario.sh" "$repo/scenarios/t1-lmmock-ai" 2>&1); rc=$?
  if [ $rc -ne 0 ] && ! echo "$out" | grep -q 'T1 mock saw the request'; then ok "control: dropping the baseURL turns T1 red (mock saw no request)"; else bad "T1 without baseURL stayed green ($rc): $out"; fi
else
  echo "SKIP T1 controls: lmmock, miniplayer or INTEGRATION_ASSETS_LMMOCK missing"
fi

rm -rf "$tmp"
if [ $fails -ne 0 ]; then echo "$fails control failure(s)"; exit 1; fi
echo "scenario controls OK"

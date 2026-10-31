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

# F. t0-fanout: swapping two prompts must move the outcomes between slots and turn the scenario red.
cp -R "$repo/scenarios/t0-fanout" "$tmp/t0-fanout-swap"
sed -i 's/\["ping", "fail me", "empty please"\]/["fail me", "ping", "empty please"]/' "$tmp/t0-fanout-swap/run.lms"
out=$(bash "$repo/scripts/run-scenario.sh" "$tmp/t0-fanout-swap" 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'FAIL slot 0 ok reply in order'; then ok "control: swapped fanout prompts turn t0-fanout red"; else bad "swapped fanout prompts stayed green ($rc): $out"; fi

# G. t0-provider-smoke-mock: removing the scripted error entry or the total entry turns it red with the expected text.
cp -R "$repo/scenarios/t0-provider-smoke-mock" "$tmp/smoke-noerr"
node -e 'const fs=require("fs");const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));delete j.scriptContains["fail me"];fs.writeFileSync(f,JSON.stringify(j))' "$tmp/smoke-noerr/store.json"
out=$(bash "$repo/scripts/run-scenario.sh" "$tmp/smoke-noerr" 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'FAIL provider error fails the case' && echo "$out" | grep -q 'expected error text: mock provider exploded'; then ok "control: removing the scriptContains error entry turns provider smoke red naming the mocked error text"; else bad "removed error entry stayed green ($rc): $out"; fi
cp -R "$repo/scenarios/t0-provider-smoke-mock" "$tmp/smoke-nototal"
node -e 'const fs=require("fs");const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));delete j.scriptContains["what is the total"];fs.writeFileSync(f,JSON.stringify(j))' "$tmp/smoke-nototal/store.json"
out=$(bash "$repo/scripts/run-scenario.sh" "$tmp/smoke-nototal" 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'FAIL turn 3 total is 10'; then ok "control: removing the total entry turns provider smoke red"; else bad "removed total entry stayed green ($rc): $out"; fi

# E. T1 (only when its tools are installed)
if [ -n "${INTEGRATION_ASSETS_LMMOCK:-}" ] && command -v lmmock >/dev/null && command -v miniplayer >/dev/null; then
  out=$(bash "$repo/scripts/run-scenario.sh" "$repo/scenarios/t1-lmmock-ai" 2>&1); rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q 'T1 mock saw the request'; then ok "T1 baseline is green"; else bad "T1 baseline ($rc): $out"; fi
  out=$(INTEGRATION_CONTROL_NO_BASEURL=1 bash "$repo/scripts/run-scenario.sh" "$repo/scenarios/t1-lmmock-ai" 2>&1); rc=$?
  if [ $rc -ne 0 ] && ! echo "$out" | grep -q 'T1 mock saw the request'; then ok "control: dropping the baseURL turns T1 red (mock saw no request)"; else bad "T1 without baseURL stayed green ($rc): $out"; fi
  # H. t1-lmmock-modes (needs a lmmock whose llm-api serves GET /__requests)
  out=$(bash "$repo/scripts/run-scenario.sh" "$repo/scenarios/t1-lmmock-modes" 2>&1); rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q 'T1 modes OK'; then ok "T1 modes baseline is green"; else bad "T1 modes baseline ($rc): $out"; fi
  cp -R "$repo/scenarios/t1-lmmock-modes" "$tmp/modes-class"
  sed -i 's/^rate-limit    error  upstream_throttled  3/rate-limit    error  auth_required  3/' "$tmp/modes-class/cases.tsv"
  out=$(bash "$repo/scripts/run-scenario.sh" "$tmp/modes-class" 2>&1); rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -q 'FAIL rate-limit: expected status=error class=auth_required'; then ok "control: a wrong expected error_class turns T1 modes red"; else bad "wrong error_class stayed green ($rc): $out"; fi
  cp -R "$repo/scenarios/t1-lmmock-modes" "$tmp/modes-count"
  sed -i 's/^retry         ok     -                   2/retry         ok     -                   1/' "$tmp/modes-count/cases.tsv"
  out=$(bash "$repo/scripts/run-scenario.sh" "$tmp/modes-count" 2>&1); rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -q 'mock served 2 requests, expected 1'; then ok "control: a wrong expected request count turns T1 modes red (the 429 attempt is counted)"; else bad "wrong request count stayed green ($rc): $out"; fi
else
  echo "SKIP T1 controls: lmmock, miniplayer or INTEGRATION_ASSETS_LMMOCK missing"
fi

rm -rf "$tmp"
if [ $fails -ne 0 ]; then echo "$fails control failure(s)"; exit 1; fi
echo "scenario controls OK"

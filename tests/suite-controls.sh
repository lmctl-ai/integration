#!/usr/bin/env bash
# Failing controls of the ported mono-test tier. Each deliberate break must turn the runner red (or, for the allowlist,
# green only while an unexpired entry covers it). Needs node; lmctl only for the version line.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
src="$repo/suites/mono-test"
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }
tmp=$(mktemp -d)
printf '#!/bin/sh\necho "lmctl 0.0.0-dummy"\n' > "$tmp/lmctl-dummy"; chmod +x "$tmp/lmctl-dummy"
export LMCTL_BIN="$tmp/lmctl-dummy"

fresh() { rm -rf "$tmp/m"; mkdir -p "$tmp/m"; cp -R "$src/." "$tmp/m/"; }

# ---- runner semantics on synthetic suites ------------------------------------------------------
synthetic() { # suites.json body
  fresh
  mkdir -p "$tmp/m/lmctl-test/tests"
  printf '%s\n' 'console.log("FAIL case alpha: boom"); process.exit(1);' > "$tmp/m/lmctl-test/tests/syn-fail.mjs"
  printf '%s\n' 'console.log("quiet crash"); process.exit(3);' > "$tmp/m/lmctl-test/tests/syn-silent.mjs"
  printf '%s\n' 'console.log("all good");' > "$tmp/m/lmctl-test/tests/syn-pass.mjs"
  printf '{"suites":[%s]}\n' "$1" > "$tmp/m/suites.json"
}
run_runner() { (cd "$tmp/m" && node run.mjs "$@" 2>&1); }
fail_suite='{"id":"syn-fail","kind":"node","file":"syn-fail.mjs"}'
entry='{"suite":"syn-fail","match":"case alpha","reason":"known skew","owner":"someone","expires":"2099-01-01"}'

synthetic "$fail_suite"; echo '[]' > "$tmp/m/allowlist.json"
out=$(run_runner); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q '^FAIL    syn-fail'; then ok "control: a failing suite without an allowlist entry is red"; else bad "failing suite not red ($rc): $out"; fi

echo "[$entry]" > "$tmp/m/allowlist.json"
out=$(run_runner); rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q '^ALLOWED syn-fail'; then ok "allowlist: covered failure is ALLOWED while the entry is unexpired"; else bad "covered failure not allowed ($rc): $out"; fi

out=$(run_runner --today 2099-01-02); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'allowlist entry expired 2099-01-01'; then ok "control: an expired allowlist entry turns the suite red"; else bad "expired entry stayed green ($rc): $out"; fi

echo "[$(echo "$entry" | sed 's/case alpha/case beta/')]" > "$tmp/m/allowlist.json"
out=$(run_runner); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'uncovered: FAIL case alpha'; then ok "control: removing the matching entry (different match) turns the suite red"; else bad "uncovered failure stayed green ($rc): $out"; fi

echo '[{"suite":"syn-fail","match":"case alpha","reason":"x","owner":"o"}]' > "$tmp/m/allowlist.json"
out=$(run_runner); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'lacks expires'; then ok "control: an allowlist entry without expires is refused"; else bad "entry without expires accepted ($rc): $out"; fi

synthetic '{"id":"syn-silent","kind":"node","file":"syn-silent.mjs"}'; echo '[]' > "$tmp/m/allowlist.json"
out=$(run_runner); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q 'unclassified failure'; then ok "control: a non-zero exit without a recognizable failure line is red"; else bad "silent crash not red ($rc): $out"; fi

synthetic '{"id":"syn-pass","kind":"node","file":"syn-pass.mjs"}'; echo '[{"suite":"syn-pass","match":"old finding","reason":"x","owner":"o","expires":"2099-01-01"}]' > "$tmp/m/allowlist.json"
out=$(run_runner); rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q 'notice: syn-pass: "old finding" no longer fails'; then ok "stale allowlist entry of a green suite is reported"; else bad "stale entry not reported ($rc): $out"; fi

# ---- pure suites: a deliberate mutation of the code under test turns them red ---------------------
count=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$src/mutations.json")
for i in $(seq 0 $((count - 1))); do
  fresh
  desc=$(node -e '
    const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))[Number(process.argv[2])];
    const f=process.argv[3]+"/"+m.file; const s=fs.readFileSync(f,"utf8");
    if(!s.includes(m.from)){console.error("mutation anchor missing: "+m.id);process.exit(3);}
    fs.writeFileSync(f,s.replace(m.from,m.to)); console.log(m.id+"|"+m.suites.join(","));
  ' "$src/mutations.json" "$i" "$tmp/m") || { bad "mutation $i: anchor missing"; continue; }
  name=${desc%%|*}; suites=${desc##*|}
  echo '[]' > "$tmp/m/allowlist.json"
  # the pristine suites must be green first, otherwise the control proves nothing
  out0=$(cd "$src" && node run.mjs --only "$suites" --allowlist "$tmp/m/allowlist.json" 2>&1); rc0=$?
  out=$(run_runner --only "$suites"); rc=$?
  if [ $rc0 -eq 0 ] && [ $rc -ne 0 ]; then ok "control: mutation '$name' turns $suites red (pristine green)"; else bad "mutation '$name': pristine rc=$rc0 mutated rc=$rc"; echo "$out0" | tail -5; fi
done

rm -rf "$tmp"
if [ $fails -ne 0 ]; then echo "$fails suite-control failure(s)"; exit 1; fi
echo "suite controls OK"

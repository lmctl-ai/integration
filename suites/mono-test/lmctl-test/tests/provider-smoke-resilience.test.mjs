// provider-smoke.mjs must never stop at the first failure: a failing check, a stalled turn, or a thrown error in one provider
// still lets every other provider (and every other check of that provider) run, and a pass on retry is shown as FLAKY.
// Deterministic and free: a fake `lmctl` shim plays the providers. SMOKE_SCRIPT overrides the script under test (to prove the
// test fails against an older version).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = process.env.SMOKE_SCRIPT || join(here, 'provider-smoke.mjs');
const root = mkdtempSync(join(tmpdir(), 'smoke-resilience-'));
const state = join(root, 'state'); mkdirSync(state);
const config = join(root, 'config.json');
writeFileSync(config, JSON.stringify({ providers: Object.fromEntries(['fakea', 'fakeb', 'fakec'].map(id => [id, { enabled: true, model: 'm', requires_bin: 'node', tiers: ['smoke'] }])) }));
// The shim: `seed` appends a session id to the teamfile; `script -e` prints the SMOKE-JSON line the test parses.
// fakeb stalls its first turn on its first attempt only (a transient stall); the other providers always answer correctly.
const shim = join(root, 'lmctl');
writeFileSync(shim, `#!/usr/bin/env bash
if [ "$1" = "--non-interactive" ] && [ "$2" = "seed" ]; then printf ' sessionid=ses_fake\\n' >> "$3"; exit 0; fi
if [ "$1" = "script" ]; then
  id=$(basename "$PWD" | sed 's/-[0-9]*$//')
  n=$(cat "$FAKE_STATE/$id.count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$FAKE_STATE/$id.count"
  if [ "$id" = fakeb ] && [ "$n" = 1 ]; then
    echo 'SMOKE-JSON [{"status":"stalled","reply":"","error":"stalled"},{"status":"ok","reply":"OK","error":""},{"status":"ok","reply":"OK","error":""},{"status":"ok","reply":"10","error":""}]'
  else
    echo 'SMOKE-JSON [{"status":"ok","reply":"PONG","error":""},{"status":"ok","reply":"OK","error":""},{"status":"ok","reply":"OK","error":""},{"status":"ok","reply":"10","error":""}]'
  fi
  exit 0
fi
exit 1
`);
chmodSync(shim, 0o755);

function run(extraEnv, args = []) {
  for (const f of ['fakea', 'fakeb', 'fakec']) writeFileSync(join(state, f + '.count'), '0');
  const r = spawnSync('node', [script, '--providers', 'fakea,fakeb,fakec', ...args], {
    encoding: 'utf8', env: { ...process.env, LMCTL_BIN: shim, LMCTL_LIVE_CONFIG: config, FAKE_STATE: state, ...extraEnv }, timeout: 60000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
let n = 0; const ok = (name, fn) => { fn(); n++; console.log(`PASS ${name}`); };

const a = run({});            // no retries: fakeb's stalled first turn fails, but the run goes on
ok('a stalled first turn fails only that check; the later checks of the same provider and the next provider still run', () => {
  assert.match(a.out, /FAIL\s+fakeb: 4 turns completed/);
  assert.match(a.out, /PASS\s+fakeb: multi-turn memory: 3 \+ 7 = 10/, 'the memory check of the later turns must still run');
  assert.match(a.out, /== fakec/, 'the provider after the failing one must run');
  assert.match(a.out, /3 providers: 2 pass, (?:0 warn, )?1 fail \(fakeb\)/);
  assert.equal(a.code, 1);
});
const b = run({ LMCTL_SMOKE_RETRIES: '1' });
ok('a transient failure that passes on retry is a pass, shown as FLAKY with the first failure', () => {
  assert.match(b.out, /RETRY fakeb/);
  assert.match(b.out, /fakeb\s+PASS.*FLAKY: passed on retry 1; first attempt failed: .*4 turns completed/);
  assert.match(b.out, /3 providers: 3 pass, (?:0 warn, )?0 fail/);
  assert.equal(b.code, 0);
});
const c = run({ LMCTL_SMOKE_INJECT_CRASH: 'fakeb' });
ok('a thrown error in one provider is recorded as a failure and the other providers still run', () => {
  assert.match(c.out, /FAIL\s+fakeb: unexpected error/);
  assert.match(c.out, /== fakec/);
  assert.match(c.out, /fakec\s+PASS/);
  assert.match(c.out, /3 providers: 2 pass, (?:0 warn, )?1 fail \(fakeb\)/);
  assert.equal(c.code, 1);
});
const d = run({ LMCTL_SMOKE_INJECT_CRASH: 'fakeb', LMCTL_SMOKE_RETRIES: '1' });
ok('a retry after a crash gets its own directory and cannot crash the run again', () => {
  assert.doesNotMatch(d.out, /EEXIST/);
  assert.match(d.out, /fakec\s+PASS/);
  assert.equal(d.code, 1);
});
console.log(`${n} assertions: ${n} pass, 0 fail`);

// Tests for operator rule (2026-10-20): "ratelimit is never a gate, at most warning".
// Stubs providers to verify:
// 1. 429 only -> WARN, exit 0
// 2. 429 + real failure -> FAIL, exit 1
// 3. Unknown error -> FAIL, exit 1
// 4. Model refusal -> FAIL, exit 1
// 5. Stalled before first token -> FAIL, exit 1
// 6. Second signal (lmctl ratelimit --json) -> WARN when exhausted, FAIL when not exhausted
// 7. Shared classifier functions fail closed on refusals, stalls, syntax, unknown errors

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isModelRefusal,
  isStallOrTimeout,
  isExplicitRateOrQuotaLimit,
  isLimitShaped,
  classifyProviderFailure,
  classifyTextForModelsValidity,
  checkProviderRatelimitSignal,
} from './rate-limit-classifier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const smokeScript = join(here, 'provider-smoke.mjs');

test('shared classifier: explicit rate-limit, usage-limit, credit-exhaustion', () => {
  for (const text of [
    'Turn errored: exceeded retry limit, last status: 429 Too Many Requests',
    'HTTP 429: Too Many Requests',
    'Error: rate limit exceeded for model gpt-6-luna',
    'You have reached your rate-limit for the day',
    'Usage limit reached for this billing period',
    "You're out of usage credits. Switch to another model, or manage usage credits in settings.",
    'Quota exceeded: check your plan and billing details',
    'Exceeded current quota for project',
    'credit-exhaustion: zero balance available',
    'insufficient-credits: balance is 0',
  ]) {
    assert.equal(isExplicitRateOrQuotaLimit(text), true, `should classify as explicit rate limit: ${text}`);
    const c = classifyProviderFailure(text);
    assert.equal(c.isRateLimit, true, `classifyProviderFailure should return isRateLimit=true for: ${text}`);
    assert.ok(['quota_exhausted', 'upstream_throttled'].includes(c.class));
  }
});

test('shared classifier fails closed: model refusal is never a rate limit', () => {
  for (const text of [
    'The model may not exist or you may not have access.',
    'unknown model: claude-bogus-9-9',
    'invalid model: gpt-9-nova',
    'Model gpt-9-test-low not found',
    'model_not_offered',
    'invalid model; You are out of usage credits.',
    'The model may not exist or you may not have access (status: 429)',
  ]) {
    assert.equal(isModelRefusal(text), true, `should detect model refusal: ${text}`);
    assert.equal(isExplicitRateOrQuotaLimit(text), false, `refusal must not be classified as rate limit: ${text}`);
    assert.equal(classifyProviderFailure(text).isRateLimit, false, `classifyProviderFailure must be false: ${text}`);
    assert.equal(classifyTextForModelsValidity(text), null, `models validity must not classify refusal as inconclusive: ${text}`);
  }
});

test('shared classifier fails closed: stalls, hangs and timeouts are never rate limits', () => {
  for (const text of [
    'stalled before first token',
    'stalled:stalled',
    'operation timed out after 240000ms',
    'idleTimeoutMs exceeded',
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    '429 Too Many Requests (stalled before first token)',
    'rate limit check timed out',
  ]) {
    assert.equal(isStallOrTimeout(text), true, `should detect stall/timeout: ${text}`);
    assert.equal(isExplicitRateOrQuotaLimit(text), false, `timeout/stall must not be rate limit: ${text}`);
    assert.equal(classifyProviderFailure(text).isRateLimit, false);
    assert.equal(classifyTextForModelsValidity(text), null);
  }
});

test('shared classifier fails closed: unknown errors, syntax, and binary missing are never rate limits', () => {
  for (const text of [
    'SyntaxError: Unexpected identifier',
    'TypeError: Cannot read properties of undefined',
    'AssertionError: Expected 10 but received 15',
    'binary node on PATH: not found in PATH',
    'required environment present: not set: API_KEY',
    'Command exited with code 1',
    'Unknown fatal error in subprocess',
  ]) {
    assert.equal(isExplicitRateOrQuotaLimit(text), false, `must not be rate limit: ${text}`);
    assert.equal(classifyProviderFailure(text).isRateLimit, false);
    assert.equal(classifyTextForModelsValidity(text), null);
  }
});

test('shared classifier models-validity adapter returns exact inconclusive classes', () => {
  assert.equal(classifyTextForModelsValidity("You're out of usage credits."), 'quota_exhausted');
  assert.equal(classifyTextForModelsValidity("Quota exceeded for project"), 'quota_exhausted');
  assert.equal(classifyTextForModelsValidity("429 Too Many Requests"), 'upstream_throttled');
  assert.equal(classifyTextForModelsValidity("rate limit exceeded"), 'upstream_throttled');
  assert.equal(classifyTextForModelsValidity("exceeded retry limit, last status: 429"), 'upstream_throttled');
  assert.equal(classifyTextForModelsValidity("unknown error"), null);
});

test('shared classifier reject-first rule: infrastructure/auth with 429 is error, never rate limit; second signal cannot rescue it; bare config phrases are not model refusals', () => {
  const infraWith429 = [
    'permission denied; HTTP 429',
    'failed to load model config: no such file; HTTP 429',
    'authentication failed; HTTP 429',
  ];
  for (const text of infraWith429) {
    assert.equal(isExplicitRateOrQuotaLimit(text), false, `reject-first must not be explicit rate limit: ${text}`);
    const res = classifyProviderFailure(text);
    assert.equal(res.isRateLimit, false, `reject-first must not have isRateLimit: true: ${text}`);
    assert.equal(res.class, 'error', `reject-first must have class 'error': ${text}`);
    assert.equal(classifyTextForModelsValidity(text), null, `models validity must not classify reject-first as inconclusive: ${text}`);
  }

  // Bare config/cache phrases must not be classified as model refusal
  const bareConfig = [
    'model config does not exist',
    'model cache not found',
    'invalid model configuration',
  ];
  for (const text of bareConfig) {
    assert.equal(isModelRefusal(text), false, `bare config must not be model refusal: ${text}`);
    assert.equal(isModelRefusal(text, 'claude-bogus-9-9'), false, `bare config with id must not be model refusal: ${text}`);
  }

  // Second signal cannot rescue reject-first errors
  const root = mkdtempSync(join(tmpdir(), 'smoke-rescue-test-'));
  try {
    const shim = join(root, 'lmctl');
    writeFileSync(shim, `#!/usr/bin/env bash
if [ "$1" = "ratelimit" ]; then
  cat << 'EOF'
{"readings":[{"provider":"codex","ordinary_usage_allowed":false,"exhausted":true}]}
EOF
  exit 0
fi
exit 1
`);
    chmodSync(shim, 0o755);
    for (const text of infraWith429) {
      const res = classifyProviderFailure(text, 'codex', { bin: shim });
      assert.equal(res.isRateLimit, false, `second signal must NOT rescue reject-first error: ${text}`);
      assert.equal(res.class, 'error');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Helper for running provider-smoke against mock environments
function runSmoke(root, configProviders, scriptBehavior, extraEnv = {}) {
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({
    providers: Object.fromEntries(configProviders.map(id => [id, { enabled: true, model: 'm', requires_bin: 'node', tiers: ['smoke'] }]))
  }));

  const shim = join(root, 'lmctl');
  writeFileSync(shim, `#!/usr/bin/env bash
if [ "$1" = "--non-interactive" ] && [ "$2" = "seed" ]; then
  id=$(basename "$PWD" | sed 's/-[0-9]*$//')
  if [ -f "$FAKE_STATE/$id.seed_fail" ]; then
    cat "$FAKE_STATE/$id.seed_fail" >&2
    exit 1
  fi
  printf ' sessionid=ses_%s\\n' "$id" >> "$3"
  exit 0
fi

if [ "$1" = "ratelimit" ]; then
  target="$2"
  if [ -f "$FAKE_STATE/$target.ratelimit" ]; then
    cat "$FAKE_STATE/$target.ratelimit"
    exit 0
  fi
  echo '{"readings":[{"provider":"'"$target"'","status":"ok","ordinary_usage_allowed":true,"buckets":[]}]}'
  exit 0
fi

if [ "$1" = "script" ]; then
  id=$(basename "$PWD" | sed 's/-[0-9]*$//')
  if [ -f "$FAKE_STATE/$id.script_output" ]; then
    cat "$FAKE_STATE/$id.script_output"
    exit 0
  fi
  echo 'SMOKE-JSON [{"status":"ok","reply":"PONG","error":""},{"status":"ok","reply":"OK","error":""},{"status":"ok","reply":"OK","error":""},{"status":"ok","reply":"10","error":""}]'
  exit 0
fi

exit 1
`);
  chmodSync(shim, 0o755);

  const env = {
    ...process.env,
    LMCTL_BIN: shim,
    LMCTL_LIVE_CONFIG: config,
    FAKE_STATE: state,
    ...extraEnv,
  };

  const r = spawnSync(process.execPath, [smokeScript, '--providers', configProviders.join(',')], {
    encoding: 'utf8',
    env,
    timeout: 30000,
  });

  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('provider-smoke: 429 only results in WARN and exit 0 (gate passes)', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-429-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    // Provider codex fails all turns with 429
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"}' +
      ']\n'
    );

    const res = runSmoke(root, ['codex', 'agy'], {});
    assert.match(res.out, /codex\s+WARN\s+\(2\/6 checks\)/);
    assert.match(res.out, /429 Too Many Requests/);
    assert.match(res.out, /agy\s+PASS/);
    assert.match(res.out, /2 providers: 1 pass, 1 warn, 0 fail/);
    assert.equal(res.code, 0, 'gate must PASS (exit 0) when failures are only warnings');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: seed failure with 429 results in WARN and exit 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-seed-429-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'codex.seed_fail'), 'ERROR: exceeded retry limit, last status: 429 Too Many Requests\n');

    const res = runSmoke(root, ['codex', 'agy'], {});
    assert.match(res.out, /codex\s+WARN\s+\(1\/2 checks\)/);
    assert.match(res.out, /2 providers: 1 pass, 1 warn, 0 fail/);
    assert.equal(res.code, 0, 'seed failure due to 429 must be WARN with exit 0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: 429 plus real logic failure on same provider fails closed (exit 1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-mixed-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    // Turn 0 replied "WRONG" (logic failure on ping), Turn 1 had 429
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"ok","reply":"WRONG","error":""},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"}' +
      ']\n'
    );

    const res = runSmoke(root, ['codex'], {});
    assert.match(res.out, /codex\s+FAIL/);
    assert.match(res.out, /1 providers: 0 pass, 0 warn, 1 fail \(codex\)/);
    assert.equal(res.code, 1, 'mixed failure must FAIL closed (exit 1)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: 429 on turn 2 and wrong reply on memory turn 3 fails closed (exit 1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-wrong-memory-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    // Turn 0 PONG, Turn 1 OK, Turn 2 429, Turn 3 "99" (invalid arithmetic answer)
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"ok","reply":"PONG","error":""},' +
      '{"status":"ok","reply":"OK","error":""},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"},' +
      '{"status":"ok","reply":"99","error":""}' +
      ']\n'
    );

    const res = runSmoke(root, ['codex'], {});
    assert.match(res.out, /codex\s+FAIL/);
    assert.match(res.out, /1 providers: 0 pass, 0 warn, 1 fail \(codex\)/);
    assert.equal(res.code, 1, 'wrong memory answer on turn 3 must FAIL closed (exit 1)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: silently stopped early with missing turns fails closed (exit 1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-missing-turns-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    // Only 2 turns returned instead of 4
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"}' +
      ']\n'
    );

    const res = runSmoke(root, ['codex'], {});
    assert.match(res.out, /codex\s+FAIL/);
    assert.match(res.out, /1 providers: 0 pass, 0 warn, 1 fail \(codex\)/);
    assert.equal(res.code, 1, 'missing turns must FAIL closed (exit 1)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: silently stopped early with 2 of 4 turns completed fails turns check', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-truncated-turns-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    // Only 2 of 4 turns returned, both 'ok'
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"ok","reply":"PONG","error":""},' +
      '{"status":"ok","reply":"OK","error":""}' +
      ']\n'
    );

    const res = runSmoke(root, ['codex'], {});
    assert.match(res.out, /FAIL\s+codex:\s+4 turns completed/);
    assert.match(res.out, /codex\s+FAIL/);
    assert.equal(res.code, 1, 'truncated turns must fail turn count check and exit 1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rate-limit-classifier: checkProviderRatelimitSignal requires exact provider match without readings[0] fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-ratelimit-fallback-'));
  try {
    const shim = join(root, 'lmctl');
    // Return reading for 'agy' that is exhausted, but NO reading for 'codex'
    writeFileSync(shim, `#!/usr/bin/env bash
if [ "$1" = "ratelimit" ]; then
  echo '{"readings":[{"provider":"agy","status":"ok","ordinary_usage_allowed":false,"buckets":[{"is_exhausted":true}]}]}'
  exit 0
fi
exit 1
`);
    chmodSync(shim, 0o755);
    assert.equal(checkProviderRatelimitSignal('codex', { bin: shim }), false, 'must return false for codex when readings only contain agy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rate-limit-classifier: refusal guard recognizes "no access" and keeps precedence over 429', () => {
  const text = 'no access to model; HTTP 429';
  assert.equal(isModelRefusal(text), true, 'should recognize no access as model refusal');
  assert.equal(isExplicitRateOrQuotaLimit(text), false, 'refusal must keep precedence over 429');
});

test('provider-smoke: 429 on one provider and real failure on another fails closed (exit 1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-multi-mixed-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    // codex has 429 (WARN)
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"},' +
      '{"status":"error","reply":"","error":"Turn errored: exceeded retry limit, last status: 429 Too Many Requests"}' +
      ']\n'
    );
    // agy has math error (real failure: 3 + 7 = 99)
    writeFileSync(join(state, 'agy.script_output'),
      'SMOKE-JSON [' +
      '{"status":"ok","reply":"PONG","error":""},' +
      '{"status":"ok","reply":"OK","error":""},' +
      '{"status":"ok","reply":"OK","error":""},' +
      '{"status":"ok","reply":"99","error":""}' +
      ']\n'
    );

    const res = runSmoke(root, ['codex', 'agy'], {});
    assert.match(res.out, /codex\s+WARN/);
    assert.match(res.out, /agy\s+FAIL/);
    assert.match(res.out, /2 providers: 0 pass, 1 warn, 1 fail \(agy\)/);
    assert.equal(res.code, 1, 'any real failure must fail the run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: unknown error results in FAIL and exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-unknown-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"error","reply":"","error":"Fatal: unexpected internal transport crash"},' +
      '{"status":"error","reply":"","error":"Fatal: unexpected internal transport crash"},' +
      '{"status":"error","reply":"","error":"Fatal: unexpected internal transport crash"},' +
      '{"status":"error","reply":"","error":"Fatal: unexpected internal transport crash"}' +
      ']\n'
    );

    const res = runSmoke(root, ['codex'], {});
    assert.match(res.out, /codex\s+FAIL/);
    assert.match(res.out, /1 providers: 0 pass, 0 warn, 1 fail \(codex\)/);
    assert.equal(res.code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: model refusal results in FAIL and exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-refusal-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"error","reply":"","error":"The model may not exist or you may not have access."}' +
      ']\n'
    );

    const res = runSmoke(root, ['codex'], {});
    assert.match(res.out, /codex\s+FAIL/);
    assert.match(res.out, /1 providers: 0 pass, 0 warn, 1 fail \(codex\)/);
    assert.equal(res.code, 1, 'model refusal must never be softened to a warning');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: stalled before first token is annotated and results in FAIL', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-stall-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"stalled","reply":"","error":"stalled"},' +
      '{"status":"ok","reply":"OK","error":""},' +
      '{"status":"ok","reply":"OK","error":""},' +
      '{"status":"ok","reply":"10","error":""}' +
      ']\n'
    );

    const res = runSmoke(root, ['codex'], {});
    assert.match(res.out, /stalled before first token/);
    assert.match(res.out, /codex\s+FAIL/);
    assert.match(res.out, /1 providers: 0 pass, 0 warn, 1 fail \(codex\)/);
    assert.equal(res.code, 1, 'stall must not be treated as a rate limit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: second signal (lmctl ratelimit --json) converts limit-shaped error to WARN', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-signal-warn-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    // Error is limit-shaped but doesn't say 429
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"error","reply":"","error":"exceeded capacity for requested tier"},' +
      '{"status":"error","reply":"","error":"exceeded capacity for requested tier"},' +
      '{"status":"error","reply":"","error":"exceeded capacity for requested tier"},' +
      '{"status":"error","reply":"","error":"exceeded capacity for requested tier"}' +
      ']\n'
    );
    // lmctl ratelimit reports limit exhausted
    writeFileSync(join(state, 'codex.ratelimit'), JSON.stringify({
      readings: [{
        provider: 'codex',
        status: 'ok',
        ordinary_usage_allowed: false,
        buckets: [{ is_exhausted: true, limit_reached: true, allowed: false }]
      }]
    }));

    const res = runSmoke(root, ['codex'], {});
    assert.match(res.out, /codex\s+WARN/);
    assert.match(res.out, /1 providers: 0 pass, 1 warn, 0 fail/);
    assert.equal(res.code, 0, 'second signal must convert limit-shaped failure to WARN');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: second signal negative control (limit NOT exhausted stays FAIL)', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-signal-fail-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    // Error is limit-shaped but doesn't say 429
    writeFileSync(join(state, 'codex.script_output'),
      'SMOKE-JSON [' +
      '{"status":"error","reply":"","error":"exceeded capacity for requested tier"},' +
      '{"status":"error","reply":"","error":"exceeded capacity for requested tier"},' +
      '{"status":"error","reply":"","error":"exceeded capacity for requested tier"},' +
      '{"status":"error","reply":"","error":"exceeded capacity for requested tier"}' +
      ']\n'
    );
    // lmctl ratelimit reports NOT exhausted
    writeFileSync(join(state, 'codex.ratelimit'), JSON.stringify({
      readings: [{
        provider: 'codex',
        status: 'ok',
        ordinary_usage_allowed: true,
        buckets: [{ is_exhausted: false, limit_reached: false, allowed: true }]
      }]
    }));

    const res = runSmoke(root, ['codex'], {});
    assert.match(res.out, /codex\s+FAIL/);
    assert.match(res.out, /1 providers: 0 pass, 0 warn, 1 fail \(codex\)/);
    assert.equal(res.code, 1, 'when limit is not exhausted, error must remain FAIL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider-smoke: anonymous provider (miniplayer) with 429 only results in WARN (exit 0)', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-anon-warn-'));
  try {
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    const config = join(root, 'config.json');
    writeFileSync(config, JSON.stringify({
      providers: {
        miniplayer: { enabled: true, model: 'm', requires_bin: 'node', tiers: ['smoke'], anonymous: true }
      }
    }));

    const shim = join(root, 'lmctl');
    writeFileSync(shim, `#!/usr/bin/env bash
if [ "$1" = "script" ]; then
  echo 'SMOKE-JSON [{"status":"error","reply":"","error":"HTTP 429: Too Many Requests"},{"status":"error","reply":"","error":"HTTP 429: Too Many Requests"}]'
  exit 0
fi
exit 1
`);
    chmodSync(shim, 0o755);

    const r = spawnSync(process.execPath, [smokeScript, '--providers', 'miniplayer'], {
      encoding: 'utf8',
      env: { ...process.env, LMCTL_BIN: shim, LMCTL_LIVE_CONFIG: config, FAKE_STATE: state },
      timeout: 30000,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.match(out, /miniplayer\s+WARN\s+\(1\/4 checks\)/);
    assert.match(out, /1 providers: 0 pass, 1 warn, 0 fail/);
    assert.equal(r.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('periodic-check.sh records WARN summary into history.tsv as PASS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-periodic-'));
  try {
    const log = join(root, 'test.log');
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(log, `
== provider smoke (tier periodic)
Provider   Result
codex      WARN   (2/6 checks)  429 Too Many Requests
agy        PASS   (6/6 checks)
2 providers: 1 pass, 1 warn, 0 fail [warn: codex: 429 Too Many Requests]
RESULT: PASS
`);
    // Replicate the periodic-check.sh summary extraction and recording
    const script = `
repo="${root}"; state="${state}"; log="${log}"; rc=0
tot_p=0; tot_pass=0; tot_warn=0; tot_fail=0; all_warns=""
found_summary=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if [[ "$line" =~ ^([0-9]+)[[:space:]]+providers:[[:space:]]*([0-9]+)[[:space:]]*pass,[[:space:]]*([0-9]+)[[:space:]]*warn,[[:space:]]*([0-9]+)[[:space:]]*fail(.*)$ ]]; then
    tot_p=$(( tot_p + BASH_REMATCH[1] ))
    tot_pass=$(( tot_pass + BASH_REMATCH[2] ))
    tot_warn=$(( tot_warn + BASH_REMATCH[3] ))
    tot_fail=$(( tot_fail + BASH_REMATCH[4] ))
    extra="\${BASH_REMATCH[5]}"
    if [[ "$extra" =~ \\[([[:space:]]*warn:[[:space:]]*)?(.*)\\] ]]; then
      wmsg="\${BASH_REMATCH[2]}"
      if [[ -n "$wmsg" ]]; then
        if [[ -n "$all_warns" ]]; then all_warns="$all_warns; $wmsg"; else all_warns="$wmsg"; fi
      fi
    fi
    found_summary=1
  elif [[ "$line" =~ ^([0-9]+)[[:space:]]+providers:[[:space:]]*([0-9]+)[[:space:]]*pass,[[:space:]]*([0-9]+)[[:space:]]*fail(.*)$ ]]; then
    tot_p=$(( tot_p + BASH_REMATCH[1] ))
    tot_pass=$(( tot_pass + BASH_REMATCH[2] ))
    tot_fail=$(( tot_fail + BASH_REMATCH[3] ))
    found_summary=1
  fi
done < <(grep -E '^[0-9]+ providers:' "$log" 2>/dev/null)

if [[ $found_summary -eq 1 ]]; then
  warn_suffix=""
  [[ -n "$all_warns" ]] && warn_suffix=" [warn: $all_warns]"
  summary="\${tot_p} providers: \${tot_pass} pass, \${tot_warn} warn, \${tot_fail} fail\${warn_suffix}"
fi

printf '%s\\t%s\\t%s\\t%s\\n' "$(date -u +%FT%TZ)" "0.2.356" "PASS" "\${summary:-no provider summary}" >> "$state/history.tsv"
echo "$summary"
`;
    const summary = spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout.trim();
    assert.match(summary, /2 providers: 1 pass, 1 warn, 0 fail/);
    const recorded = readFileSync(join(state, 'history.tsv'), 'utf8');
    assert.match(recorded, /PASS\t2 providers: 1 pass, 1 warn, 0 fail/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('periodic-check.sh aggregates models-validity warnings and smoke into summary and history.tsv', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-periodic-mv-'));
  try {
    const log = join(root, 'test.log');
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    writeFileSync(log, `
== command-coverage: PASS
== offline-commands: PASS
== models-validity: WARN
== models-validity codex: PASS 1 ids
== models-validity agy: PASS 1 ids
== models-validity kimi: PASS 2 ids
== models-validity claude: WARN 0 ids (cannot establish cheapest)
WARN claude: NOT PROBED: cannot establish cheapest
4 providers: 3 pass, 1 warn, 0 fail [warn: claude: NOT PROBED: cannot establish cheapest]
== provider smoke (tier periodic)
Provider   Result
codex      WARN   (2/6 checks)  429 Too Many Requests
agy        PASS   (6/6 checks)
2 providers: 1 pass, 1 warn, 0 fail [warn: codex: 429 Too Many Requests]
RESULT: PASS
`);
    const script = `
repo="${root}"; state="${state}"; log="${log}"; rc=0
tot_p=0; tot_pass=0; tot_warn=0; tot_fail=0; all_warns=""
found_summary=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if [[ "$line" =~ ^([0-9]+)[[:space:]]+providers:[[:space:]]*([0-9]+)[[:space:]]*pass,[[:space:]]*([0-9]+)[[:space:]]*warn,[[:space:]]*([0-9]+)[[:space:]]*fail(.*)$ ]]; then
    tot_p=$(( tot_p + BASH_REMATCH[1] ))
    tot_pass=$(( tot_pass + BASH_REMATCH[2] ))
    tot_warn=$(( tot_warn + BASH_REMATCH[3] ))
    tot_fail=$(( tot_fail + BASH_REMATCH[4] ))
    extra="\${BASH_REMATCH[5]}"
    if [[ "$extra" =~ \\[([[:space:]]*warn:[[:space:]]*)?(.*)\\] ]]; then
      wmsg="\${BASH_REMATCH[2]}"
      if [[ -n "$wmsg" ]]; then
        if [[ -n "$all_warns" ]]; then all_warns="$all_warns; $wmsg"; else all_warns="$wmsg"; fi
      fi
    fi
    found_summary=1
  elif [[ "$line" =~ ^([0-9]+)[[:space:]]+providers:[[:space:]]*([0-9]+)[[:space:]]*pass,[[:space:]]*([0-9]+)[[:space:]]*fail(.*)$ ]]; then
    tot_p=$(( tot_p + BASH_REMATCH[1] ))
    tot_pass=$(( tot_pass + BASH_REMATCH[2] ))
    tot_fail=$(( tot_fail + BASH_REMATCH[3] ))
    found_summary=1
  fi
done < <(grep -E '^[0-9]+ providers:' "$log" 2>/dev/null)

if [[ $found_summary -eq 1 ]]; then
  warn_suffix=""
  [[ -n "$all_warns" ]] && warn_suffix=" [warn: $all_warns]"
  summary="\${tot_p} providers: \${tot_pass} pass, \${tot_warn} warn, \${tot_fail} fail\${warn_suffix}"
fi

printf '%s\\t%s\\t%s\\t%s\\n' "$(date -u +%FT%TZ)" "0.2.356" "PASS" "\${summary:-no provider summary}" >> "$state/history.tsv"
echo "$summary"
`;
    const res = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    const summary = res.stdout.trim();
    assert.match(summary, /6 providers: 4 pass, 2 warn, 0 fail/);
    assert.match(summary, /claude: NOT PROBED: cannot establish cheapest/);
    assert.match(summary, /codex: 429 Too Many Requests/);

    const history = readFileSync(join(state, 'history.tsv'), 'utf8');
    assert.match(history, /6 providers: 4 pass, 2 warn, 0 fail/);
    assert.match(history, /claude: NOT PROBED: cannot establish cheapest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release-pipeline verdict captures gate warnings while verdict is GATE PASSED', () => {
  const root = mkdtempSync(join(tmpdir(), 'smoke-test-verdict-'));
  try {
    const evidence = join(root, 'evidence');
    const audit = join(evidence, 'awsspot-audit');
    mkdirSync(audit, { recursive: true });
    writeFileSync(join(evidence, 'gate.log'), `
22-lmctl-test-provider-smoke:
Provider   Result
codex      WARN   (2/6 checks)  429 Too Many Requests
11 providers: 10 pass, 1 warn, 0 fail [warn: codex: 429 Too Many Requests]
`);
    writeFileSync(join(audit, '22-lmctl-test-provider-smoke.log'), `
11 providers: 10 pass, 1 warn, 0 fail [warn: codex: 429 Too Many Requests]
`);
    const verdict = join(evidence, 'VERDICT.md');
    writeFileSync(verdict, '# release pipeline 0.2.356\n- awsspot gate: exit 0 (log: gate.log)\n');

    // Execute the warning collection logic from release-pipeline.sh
    spawnSync('bash', ['-c', `
gate_warnings="$(grep -hE '^[a-z0-9_-]+ +WARN |[0-9]+ providers:.*[1-9][0-9]* warn|INCONCLUSIVE:' "${evidence}/gate.log" "${evidence}/awsspot-audit"/*.log 2>/dev/null | sed 's/^[0-9]\\{4\\}-[0-9T:.Z-]* //' | sort -u || true)"
if [[ -n "$gate_warnings" ]]; then
  echo "- gate warnings:" >> "${verdict}"
  printf '%s\\n' "$gate_warnings" | sed 's/^/  - /' >> "${verdict}"
fi
echo "- RESULT: GATE PASSED for 0.2.356" >> "${verdict}"
    `]);

    const content = readFileSync(verdict, 'utf8');
    assert.match(content, /- awsspot gate: exit 0/);
    assert.match(content, /- gate warnings:\n  - 11 providers: 10 pass, 1 warn, 0 fail/);
    assert.match(content, /- RESULT: GATE PASSED for 0.2.356/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

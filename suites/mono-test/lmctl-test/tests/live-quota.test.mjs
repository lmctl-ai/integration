import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARBITRARY_ERROR_VECTORS,
  MODEL_REFUSAL_NEGATIVE_VECTORS,
  MODEL_REFUSAL_POSITIVE_VECTORS,
  RATE_LIMIT_VECTORS,
  REJECT_FIRST_VECTORS,
  TEST_MODEL_ID,
} from './rate-limit-vectors.mjs';

const testsDir = dirname(fileURLToPath(import.meta.url));
const lmctlTestRoot = dirname(testsDir);
function resolveRealLmctl() {
  const candidates = [
    process.env.REAL_LMCTL_BIN,
    process.env.LMCTL_BIN,
    'lmctl',
  ].filter(Boolean);

  for (const c of candidates) {
    if (c.includes('/') && existsSync(c)) {
      return realpathSync(c);
    }
    try {
      const found = execFileSync('which', [c], { encoding: 'utf8' }).trim();
      if (found && existsSync(found)) {
        return realpathSync(found);
      }
    } catch {}
  }
  throw new Error('Unable to resolve real lmctl binary');
}
const realBin = resolveRealLmctl();

function runHarness({
  quota = null,
  freshQuota = null,
  agentResult = null,
  agentResults = {},
  liveProviders = 'codex',
  liveCodexModel = 'gpt-6-luna',
  liveAgyModel = 'Gemini 3.8 Flash (Medium)',
  missingBinaries = [],
  extraEnv = {},
} = {}) {
  const harnessDir = mkdtempSync(join(tmpdir(), 'live-quota-harness-'));
  try {
    // 1. Symlink lib.lms into harnessDir for LMScript import resolution
    symlinkSync(join(testsDir, 'lib.lms'), join(harnessDir, 'lib.lms'));

    // 2. Binary stubs
    if (!missingBinaries.includes('codex')) {
      writeFileSync(join(harnessDir, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.163.0"; fi\nexit 0\n', { mode: 0o755 });
    }
    if (!missingBinaries.includes('agy')) {
      writeFileSync(join(harnessDir, 'agy'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "agy 1.4.3"; fi\nexit 0\n', { mode: 0o755 });
    }

    // 3. Data files for harness
    if (quota !== null) {
      writeFileSync(join(harnessDir, 'quota.json'), JSON.stringify(quota));
    }
    if (freshQuota !== null) {
      writeFileSync(join(harnessDir, 'fresh_quota.json'), JSON.stringify(freshQuota));
    }
    if (agentResult !== null) {
      writeFileSync(join(harnessDir, 'agent_result.json'), JSON.stringify(agentResult));
    }
    for (const [p, res] of Object.entries(agentResults)) {
      writeFileSync(join(harnessDir, `agent_result_${p}.json`), JSON.stringify(res));
    }

    // 4. Stub lmctl placed first on PATH
    const stubLmctl = join(harnessDir, 'lmctl');
    const stubCode = `#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const realBin = process.env.REAL_LMCTL_BIN || ${JSON.stringify(realBin)};
const harnessDir = process.env.HARNESS_DIR || path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "status") {
  if (process.env.HARNESS_STATUS_FAIL === "1") {
    process.stderr.write("injected readback failure\\n");
    process.exit(42);
  }
  const fileArg = args.slice(1).find(a => !a.startsWith("-"));
  let provider = "codex";
  let model = null;
  if (fileArg && fs.existsSync(fileArg)) {
    const content = fs.readFileSync(fileArg, "utf8");
    const pMatch = content.match(/provider=([^\\s]+)/);
    if (pMatch) provider = pMatch[1];
    const mMatch = content.match(/model="([^"]+)"|model=([^\\s]+)/);
    if (mMatch) model = mMatch[1] || mMatch[2];
  }
  if (!model) {
    model = provider === "agy" ? (process.env.LMCTL_LIVE_AGY_MODEL || "gemini-2.5-flash") : (process.env.LMCTL_LIVE_CODEX_MODEL || "gpt-6-luna");
  }
  let observedModel = model;
  if (provider === "agy" && process.env.HARNESS_OBSERVED_AGY_MODEL) {
    observedModel = process.env.HARNESS_OBSERVED_AGY_MODEL;
  }
  const status = {
    schema_version: 2,
    scope: "team",
    team: "probe",
    teamfile: fileArg || "",
    details: true,
    members: [{
      alias: "Probe",
      reportPath: "Probe",
      teamfile: fileArg || "",
      provider,
      sessionid: "test-session-" + provider,
      seeded: true,
      model,
      observed_model: observedModel,
      status: { model, observed_model: observedModel }
    }],
    total: { messageCount: 1 }
  };
  process.stdout.write(JSON.stringify(status));
  process.exit(0);
}

if (cmd === "script") {
  const targetScript = args.slice(1).find(a => !a.startsWith("-"));
  if (targetScript && fs.existsSync(targetScript) && !args.includes("--check") && !args.includes("--lint")) {
    const orig = fs.readFileSync(targetScript, "utf8");
    const wrapper = [
      "fn __harness_ratelimit_readings_all() {",
      "  f_all = " + JSON.stringify(path.join(harnessDir, "quota.json")) + ";",
      "  if (file_exists(f_all)) { return read_json(f_all); }",
      "  return {status: \\"ok\\", readings: []};",
      "}",
      "fn __harness_ratelimit_readings_fresh(opts) {",
      "  f_single = " + JSON.stringify(path.join(harnessDir, "fresh_quota.json")) + ";",
      "  f_all = " + JSON.stringify(path.join(harnessDir, "quota.json")) + ";",
      "  if (file_exists(f_single)) { return read_json(f_single); }",
      "  if (file_exists(f_all)) { return read_json(f_all); }",
      "  return {status: \\"ok\\", readings: []};",
      "}",
      "fn __harness_agent(agent, prompt, opts) {",
      "  p_name = get(agent, \\"provider\\", \\"\\");",
      "  agent.sessionid = \\"test-session-\\" + p_name;",
      "  p_file = " + JSON.stringify(harnessDir) + " + \\"/agent_result_\\" + p_name + \\".json\\";",
      "  d_file = " + JSON.stringify(path.join(harnessDir, "agent_result.json")) + ";",
      "  if (file_exists(p_file)) { return read_json(p_file); }",
      "  if (file_exists(d_file)) { return read_json(d_file); }",
      "  return {status: \\"ok\\", reply: \\"OK\\", sessionid: agent.sessionid};",
      "}"
    ].join("\\n") + "\\n" + orig
      .split("lm_ratelimit_readings()").join("__harness_ratelimit_readings_all()")
      .split("lm_ratelimit_readings(").join("__harness_ratelimit_readings_fresh(")
      .split("lm_agent(").join("__harness_agent(");

    const tempScript = path.join(harnessDir, "run.lms");
    fs.writeFileSync(tempScript, wrapper, "utf8");
    const scriptIdx = args.indexOf(targetScript);
    const scriptArgs = [...args.slice(1)];
    scriptArgs[scriptIdx - 1] = tempScript;
    const res = spawnSync(realBin, ["script", ...scriptArgs], {
      stdio: "pipe",
      env: process.env,
      encoding: "utf8"
    });
    process.stdout.write(res.stdout || "");
    process.stderr.write(res.stderr || "");
    process.exit(res.status ?? 1);
  }
}

const res = spawnSync(realBin, args, { stdio: "pipe", env: process.env, encoding: "utf8" });
process.stdout.write(res.stdout || "");
process.stderr.write(res.stderr || "");
process.exit(res.status ?? 1);
`;
    writeFileSync(stubLmctl, stubCode, { mode: 0o755 });

    let pathDirs = process.env.PATH.split(':');
    if (missingBinaries.length > 0) {
      pathDirs = pathDirs.filter(dir => {
        for (const mb of missingBinaries) {
          if (existsSync(join(dir, mb))) return false;
        }
        return true;
      });
    }

    const env = {
      ...process.env,
      PATH: harnessDir + ':' + pathDirs.join(':'),
      LMCTL_BIN: stubLmctl,
      REAL_LMCTL_BIN: realBin,
      HARNESS_DIR: harnessDir,
      LMCTL_LIVE_PROVIDERS: liveProviders,
      LMCTL_LIVE_CODEX_MODEL: liveCodexModel,
      LMCTL_LIVE_AGY_MODEL: liveAgyModel,
      ...extraEnv,
    };

    const res = spawnSync(stubLmctl, ['script', 'tests/live.lms'], {
      cwd: lmctlTestRoot,
      env,
      encoding: 'utf8',
      timeout: 30000,
    });

    return {
      code: res.status,
      signal: res.signal,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      output: (res.stdout || '') + (res.stderr || ''),
    };
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
}

function runClassify(errorText, provider = 'codex') {
  const res = spawnSync('node', ['tests/live-probe.mjs', 'classify', JSON.stringify({ error: errorText, provider })], {
    cwd: lmctlTestRoot,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(res.status, 0, `classify command failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('=== live.lms Quota and Warning Branch Tests ===');

// --- Override Security Tests: production code ignores inherited LMCTL_TEST_* overrides ---
check('Security: Production source code contains zero LMCTL_TEST_* override variables', () => {
  const liveLmsSrc = readFileSync(join(testsDir, 'live.lms'), 'utf8');
  const liveProbeSrc = readFileSync(join(testsDir, 'live-probe.mjs'), 'utf8');
  assert.doesNotMatch(liveLmsSrc, /LMCTL_TEST_/);
  assert.doesNotMatch(liveProbeSrc, /LMCTL_TEST_/);
});

check('Security: Inherited LMCTL_TEST_* overrides cannot fabricate a passing gate', () => {
  if (process.env.SKIP_SLOW_SECURITY_TEST === '1') {
    // Fast static guard in mutation runs
    const liveLmsSrc = readFileSync(join(testsDir, 'live.lms'), 'utf8');
    const liveProbeSrc = readFileSync(join(testsDir, 'live-probe.mjs'), 'utf8');
    assert.doesNotMatch(liveLmsSrc, /LMCTL_TEST_/);
    assert.doesNotMatch(liveProbeSrc, /LMCTL_TEST_/);
    return;
  }
  const fakeHome = mkdtempSync(join(tmpdir(), 'lmctl-no-home-'));
  try {
    const res = spawnSync(realBin, ['script', 'tests/live.lms'], {
      cwd: lmctlTestRoot,
      env: {
        ...process.env,
        HOME: fakeHome,
        OPENAI_BASE_URL: 'http://127.0.0.1:1',
        OPENAI_API_BASE: 'http://127.0.0.1:1',
        LMCTL_TEST_QUOTA_JSON: JSON.stringify({ status: 'ok', readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }] }),
        LMCTL_TEST_FRESH_QUOTA_JSON: JSON.stringify({ status: 'ok', readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }] }),
        LMCTL_TEST_AGENT_RESULT_JSON: JSON.stringify({ status: 'ok', reply: 'OK', sessionid: 'fake-session' }),
        LMCTL_TEST_AGENT_RESULT_CODEX_JSON: JSON.stringify({ status: 'ok', reply: 'OK', sessionid: 'fake-session' }),
        LMCTL_TEST_AGENT_RESULT_AGY_JSON: JSON.stringify({ status: 'ok', reply: 'OK', sessionid: 'fake-session' }),
        LMCTL_TEST_PREFLIGHT_JSON: JSON.stringify([{ provider: 'codex', binary: 'codex', found: true, version: 'fake' }]),
        LMCTL_TEST_OBSERVE_JSON: JSON.stringify({ observed: 'fake-model' }),
        LMCTL_LIVE_PROVIDERS: 'codex',
      },
      encoding: 'utf8',
      timeout: 25000,
    });
    // Must NOT exit 0 and must NOT report "1 attempted; 1 completed"
    assert.notEqual(res.status, 0, `Expected non-zero exit, got ${res.status}`);
    assert.doesNotMatch(res.stdout, /1 attempted; 1 completed/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// --- Branch 1: Quota read unreadable / timeout / refresh failed -> WARN+run ---
check('Branch 1a: Preflight quota unreadable -> WARN and proceed to run', () => {
  const res = runHarness({
    quota: { status: 'error', error: 'preflight timeout after 15s' },
  });
  assert.equal(res.code, 0, `Expected 0 exit, got ${res.code}: ${res.output}`);
  assert.match(res.output, /WARN preflight: rate-limit preflight unreadable/);
  assert.match(res.output, /WARN codex: quota unreadable/);
  assert.match(res.output, /PROMPT codex declared="gpt-6-luna"/);
  assert.match(res.output, /1 providers; 1 attempted; 1 completed; 0 skipped/);
});

check('Branch 1b: Fresh quota refresh fails -> WARN and proceed to run', () => {
  const initialQuota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }],
  };
  const freshQuota = {
    status: 'error',
    error: 'network timeout during refresh',
  };
  const res = runHarness({
    quota: initialQuota,
    freshQuota,
  });
  assert.equal(res.code, 0, `Expected 0 exit, got ${res.code}: ${res.output}`);
  assert.match(res.output, /WARN codex: quota unreadable \(quota refresh failed\); proceeding, the call itself is the availability check/);
  assert.match(res.output, /PROMPT codex declared="gpt-6-luna"/);
  assert.match(res.output, /1 providers; 1 attempted; 1 completed; 0 skipped/);
});

check('Branch 1c: Provider reading status is error/unavailable -> WARN and proceed to run', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'error', reason: 'reader_timeout' }],
  };
  const res = runHarness({ quota });
  assert.equal(res.code, 0, `Expected 0 exit, got ${res.code}: ${res.output}`);
  assert.match(res.output, /WARN codex: quota unreadable \(quota unavailable\); proceeding, the call itself is the availability check/);
  assert.match(res.output, /PROMPT codex declared="gpt-6-luna"/);
  assert.match(res.output, /1 providers; 1 attempted; 1 completed; 0 skipped/);
});

check('Branch 1d: Expected provider reading is missing from preflight -> WARN and proceed to run', () => {
  const quota = {
    status: 'ok',
    readings: [], // codex missing
  };
  const res = runHarness({ quota });
  assert.equal(res.code, 0, `Expected 0 exit, got ${res.code}: ${res.output}`);
  assert.match(res.output, /WARN codex: quota unreadable \(expected quota reading missing\); proceeding, the call itself is the availability check/);
  assert.match(res.output, /PROMPT codex declared="gpt-6-luna"/);
  assert.match(res.output, /1 providers; 1 attempted; 1 completed; 0 skipped/);
});

// --- Branch 2: Quota truly exhausted -> SKIP+WARN (other provider runs) ---
check('Branch 2a: Codex ordinary_usage_allowed=false -> SKIP+WARN and Agy runs', () => {
  const quota = {
    status: 'ok',
    readings: [
      { provider: 'codex', status: 'ok', ordinary_usage_allowed: false },
      { provider: 'agy', status: 'ok', ordinary_usage_allowed: true, buckets: [] },
    ],
  };
  const res = runHarness({
    liveProviders: 'codex,agy',
    quota,
  });
  assert.equal(res.code, 0, `Expected 0 exit, got ${res.code}: ${res.output}`);
  assert.match(res.output, /WARN codex: skipped, ordinary usage disallowed/);
  assert.match(res.output, /PROMPT agy declared="Gemini 3.8 Flash \(Medium\)"/);
  assert.match(res.output, /2 providers; 1 attempted; 1 completed; 1 skipped/);
});

check('Branch 2b: Codex spend_control.reached=true -> SKIP+WARN', () => {
  const quota = {
    status: 'ok',
    readings: [
      { provider: 'codex', status: 'ok', spend_control: { reached: true } },
      { provider: 'agy', status: 'ok', ordinary_usage_allowed: true, buckets: [] },
    ],
  };
  const res = runHarness({
    liveProviders: 'codex,agy',
    quota,
  });
  assert.equal(res.code, 0, `Expected 0 exit, got ${res.code}: ${res.output}`);
  assert.match(res.output, /WARN codex: skipped, spend control reached/);
  assert.match(res.output, /2 providers; 1 attempted; 1 completed; 1 skipped/);
});

check('Branch 2c: Codex bucket exhausted -> SKIP+WARN', () => {
  const quota = {
    status: 'ok',
    readings: [
      {
        provider: 'codex',
        status: 'ok',
        buckets: [{ bucket_id: 'codex-weekly', is_exhausted: true, used_fraction: 1 }],
      },
      { provider: 'agy', status: 'ok', ordinary_usage_allowed: true, buckets: [] },
    ],
  };
  const res = runHarness({
    liveProviders: 'codex,agy',
    quota,
  });
  assert.equal(res.code, 0, `Expected 0 exit, got ${res.code}: ${res.output}`);
  assert.match(res.output, /WARN codex: skipped, exhausted\/disallowed bucket codex-weekly/);
  assert.match(res.output, /2 providers; 1 attempted; 1 completed; 1 skipped/);
});

check('Branch 2d: Agy 3p bucket exhausted never gates Gemini Flash -> RUNS', () => {
  const quota = {
    status: 'ok',
    readings: [
      {
        provider: 'agy',
        status: 'ok',
        buckets: [{ bucket_id: '3p-weekly', is_exhausted: true, used_fraction: 1 }],
      },
    ],
  };
  const res = runHarness({
    liveProviders: 'agy',
    quota,
  });
  assert.equal(res.code, 0, `Expected 0 exit, got ${res.code}: ${res.output}`);
  assert.doesNotMatch(res.output, /WARN agy: skipped/);
  assert.match(res.output, /PROMPT agy declared="Gemini 3.8 Flash \(Medium\)"/);
});

// --- Branch 3: All providers skipped -> FAIL ("a gate that tested nothing must not pass") ---
check('Branch 3: All providers skipped due to exhausted quota -> FAIL closed (exit non-zero)', () => {
  const quota = {
    status: 'ok',
    readings: [
      { provider: 'codex', status: 'ok', ordinary_usage_allowed: false },
      {
        provider: 'agy',
        status: 'ok',
        buckets: [{ bucket_id: 'gemini-5h', is_exhausted: true, used_fraction: 1 }],
      },
    ],
  };
  const res = runHarness({
    liveProviders: 'codex,agy',
    quota,
  });
  assert.notEqual(res.code, 0, `Expected non-zero exit when all skipped, got 0: ${res.output}`);
  assert.match(res.output, /WARN codex: skipped, ordinary usage disallowed/);
  assert.match(res.output, /WARN agy: skipped, exhausted\/disallowed bucket gemini-5h/);
  assert.match(res.output, /FAIL: no core provider \(agy or codex\) was able to run; all providers skipped or unavailable/);
});

// --- Branch 4: Binary missing -> FAIL ---
check('Branch 4: Binary unavailable -> FAIL closed (exit non-zero)', () => {
  const res = runHarness({
    liveProviders: 'codex',
    missingBinaries: ['codex'],
  });
  assert.notEqual(res.code, 0, `Expected non-zero exit for missing binary, got 0: ${res.output}`);
  assert.match(res.output, /FAIL codex: binary unavailable/);
});

// --- Branch 5: Prompt failure handling (Rate-limit warning vs Model/Auth refusal fail) ---
check('Branch 5a: Codex prompt rate-limited (HTTP 429) -> WARN (does not fail gate)', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }],
  };
  const res = runHarness({
    quota,
    agentResult: {
      status: 'error',
      error: '429 Too Many Requests: rate limit exceeded',
    },
  });
  assert.equal(res.code, 0, `Expected 0 exit for rate-limited prompt, got ${res.code}: ${res.output}`);
  assert.match(res.output, /WARN codex: prompt rate-limited \/ quota exhausted: 429 Too Many Requests/);
  assert.doesNotMatch(res.output, /FAIL codex unreachable/);
});

check('Branch 5b: Codex prompt credit exhaustion -> WARN (does not fail gate)', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }],
  };
  const res = runHarness({
    quota,
    agentResult: {
      status: 'error',
      error: "You're out of usage credits",
    },
  });
  assert.equal(res.code, 0, `Expected 0 exit for credit exhaustion prompt, got ${res.code}: ${res.output}`);
  assert.match(res.output, /WARN codex: prompt rate-limited \/ quota exhausted: You're out of usage credits/);
});

check('Branch 5c: Codex prompt model refusal -> FAIL closed', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }],
  };
  const res = runHarness({
    quota,
    agentResult: {
      status: 'error',
      error: "The model 'gpt-6-luna' does not exist or you do not have access",
    },
  });
  assert.notEqual(res.code, 0, `Expected non-zero exit for model refusal, got 0: ${res.output}`);
  assert.match(res.output, /FAIL codex unreachable on its only attempt/);
});

check('Branch 5d: Codex prompt authentication failure (401) -> FAIL closed', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }],
  };
  const res = runHarness({
    quota,
    agentResult: {
      status: 'error',
      error: '401 Unauthorized: Invalid API key',
    },
  });
  assert.notEqual(res.code, 0, `Expected non-zero exit for auth failure, got 0: ${res.output}`);
  assert.match(res.output, /FAIL codex unreachable on its only attempt/);
});

check('Branch 5e: Codex prompt generic infra error (ENOENT) -> FAIL closed', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }],
  };
  const res = runHarness({
    quota,
    agentResult: {
      status: 'error',
      error: 'ENOENT: spawn codex ENOENT',
    },
  });
  assert.notEqual(res.code, 0, `Expected non-zero exit for infra error, got 0: ${res.output}`);
  assert.match(res.output, /FAIL codex unreachable on its only attempt/);
});

check('Branch 5f: Codex prompt with 429 combined with infra/auth -> FAIL closed (Reject First)', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }],
  };
  const res = runHarness({
    quota,
    agentResult: {
      status: 'error',
      error: 'failed to load model config: no such file; HTTP 429',
    },
  });
  assert.notEqual(res.code, 0, `Expected non-zero exit for reject-first with 429, got 0: ${res.output}`);
  assert.match(res.output, /FAIL codex unreachable on its only attempt/);
});

// --- B1: Difference gating and informational findings ---
check('Branch 6a (B1): Codex prompt wrong reply ("WRONG" instead of "OK") -> exit 1', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }],
  };
  const res = runHarness({
    quota,
    agentResult: {
      status: 'ok',
      reply: 'WRONG',
    },
  });
  assert.equal(res.code, 1, `Expected exit 1 for wrong prompt reply, got ${res.code}: ${res.output}`);
  assert.match(res.output, /FAIL difference: codex tiny prompt reply/);
  assert.match(res.output, /1 failing difference\(s\) detected/);
});

check('Branch 6b (B1): Session readback failure (exit non-zero) -> exit 1', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }],
  };
  const res = runHarness({
    quota,
    extraEnv: {
      HARNESS_STATUS_FAIL: '1',
    },
  });
  assert.equal(res.code, 1, `Expected exit 1 for readback failure, got ${res.code}: ${res.output}`);
  assert.match(res.output, /FAIL difference: codex session readback/);
  assert.match(res.output, /1 failing difference\(s\) detected/);
});

check('Branch 6c (B1): Informational declared/observed DIFF alone -> exit 0', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'agy', status: 'ok', ordinary_usage_allowed: true }],
  };
  const res = runHarness({
    quota,
    liveProviders: 'agy',
    liveAgyModel: 'gemini-2.5-flash',
    extraEnv: {
      HARNESS_OBSERVED_AGY_MODEL: 'Gemini 3.8 Flash (Medium)',
    },
  });
  assert.equal(res.code, 0, `Expected exit 0 for informational diff, got ${res.code}: ${res.output}`);
  assert.match(res.output, /DIFF agy declared\/observed differ; not assumed equivalent/);
  assert.match(res.output, /INFO finding \(non-failing\): agy observed model matches expectation/);
  assert.match(res.output, /DONE/);
});

check('Branch 6d (B1): Quota WARN alone -> exit 0', () => {
  const quota = {
    status: 'ok',
    readings: [{ provider: 'codex', status: 'ok', ordinary_usage_allowed: true }],
  };
  const res = runHarness({
    quota,
    agentResult: {
      status: 'error',
      error: 'HTTP 429: Too Many Requests',
    },
  });
  assert.equal(res.code, 0, `Expected exit 0 for quota WARN alone, got ${res.code}: ${res.output}`);
  assert.match(res.output, /WARN codex: prompt rate-limited/);
  assert.doesNotMatch(res.output, /FAIL: .* failing difference\(s\)/);
  assert.match(res.output, /DONE/);
});

// --- Direct live-probe classify tests with Shared Vectors ---
console.log('\n=== Shared Vector Classification Tests (live-probe.mjs classify) ===');

for (const vec of RATE_LIMIT_VECTORS) {
  check(`Vector Rate Limit: ${vec.reason} ("${vec.text}")`, () => {
    const res = runClassify(vec.text);
    assert.equal(res.isRateLimit, true, `Expected isRateLimit=true for "${vec.text}"`);
  });
}

for (const vec of REJECT_FIRST_VECTORS) {
  check(`Vector Reject First: ${vec.reason} ("${vec.text}")`, () => {
    const res = runClassify(vec.text);
    assert.equal(res.isRateLimit, false, `Expected isRateLimit=false for "${vec.text}"`);
  });
}

for (const vec of MODEL_REFUSAL_POSITIVE_VECTORS) {
  check(`Vector Model Refusal Positive: ${vec.reason} ("${vec.text}")`, () => {
    const res = runClassify(vec.text);
    assert.equal(res.isRateLimit, false, `Expected isRateLimit=false for model refusal "${vec.text}"`);
  });
}

for (const vec of MODEL_REFUSAL_NEGATIVE_VECTORS) {
  check(`Vector Model Refusal Negative: ${vec.reason} ("${vec.text}")`, () => {
    const res = runClassify(vec.text);
    assert.equal(res.isRateLimit, false, `Expected isRateLimit=false for negative refusal "${vec.text}"`);
  });
}

for (const vec of ARBITRARY_ERROR_VECTORS) {
  check(`Vector Arbitrary Error: ${vec.reason} ("${vec.text}")`, () => {
    const res = runClassify(vec.text);
    assert.equal(res.isRateLimit, false, `Expected isRateLimit=false for arbitrary error "${vec.text}"`);
  });
}

// Reviewer round 5 specific spot checks
check('Reviewer R5: "permission denied; HTTP 429" is rejected first (not rate limit)', () => {
  const res = runClassify('permission denied; HTTP 429');
  assert.equal(res.isRateLimit, false);
});

check('Reviewer R5: "failed to load model config: no such file; HTTP 429" is rejected first (not rate limit)', () => {
  const res = runClassify('failed to load model config: no such file; HTTP 429');
  assert.equal(res.isRateLimit, false);
});

check('Reviewer R5: "authentication failed; HTTP 429" is rejected first (not rate limit)', () => {
  const res = runClassify('authentication failed; HTTP 429');
  assert.equal(res.isRateLimit, false);
});

check('Reviewer R5: "model config does not exist" is not rate limit', () => {
  const res = runClassify('model config does not exist');
  assert.equal(res.isRateLimit, false);
});

check('Reviewer R5: "model cache not found" is not rate limit', () => {
  const res = runClassify('model cache not found');
  assert.equal(res.isRateLimit, false);
});

check('Reviewer R5: "invalid model configuration" is not rate limit', () => {
  const res = runClassify('invalid model configuration');
  assert.equal(res.isRateLimit, false);
});

check('Reviewer R5: "resource exhausted" is rate limit', () => {
  const res = runClassify('resource exhausted');
  assert.equal(res.isRateLimit, true);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

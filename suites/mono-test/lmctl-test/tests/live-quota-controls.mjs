import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDir = dirname(fileURLToPath(import.meta.url));
const lmctlTestRoot = dirname(suiteDir);
const tempRoot = await mkdtemp(join(tmpdir(), 'live-quota-controls-'));

const realBin = (() => {
  const candidates = [
    process.env.REAL_LMCTL_BIN,
    process.env.LMCTL_BIN,
    'lmctl',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes('/') && existsSync(c)) return realpathSync(c);
    try {
      const f = execFileSync('which', [c], { encoding: 'utf8' }).trim();
      if (f && existsSync(f)) return realpathSync(f);
    } catch {}
  }
  throw new Error('Cannot find real lmctl');
})();

try {
  const sandboxDir = join(tempRoot, 'lmctl-test');
  const sandboxTests = join(sandboxDir, 'tests');
  await mkdir(sandboxTests, { recursive: true });

  // Copy necessary test files into sandbox
  for (const name of [
    'live.lms',
    'live-probe.mjs',
    'lib.lms',
    'live-quota.test.mjs',
    'rate-limit-classifier.mjs',
    'rate-limit-vectors.mjs',
  ]) {
    await cp(join(suiteDir, name), join(sandboxTests, name));
  }
  await cp(join(suiteDir, 'providers'), join(sandboxTests, 'providers'), { recursive: true });

  const liveLmsPath = join(sandboxTests, 'live.lms');
  const liveProbePath = join(sandboxTests, 'live-probe.mjs');
  const classifierPath = join(sandboxTests, 'rate-limit-classifier.mjs');

  const origLiveLms = await readFile(liveLmsPath, 'utf8');
  const origLiveProbe = await readFile(liveProbePath, 'utf8');
  const origClassifier = await readFile(classifierPath, 'utf8');

  function runTest() {
    const res = spawnSync(process.execPath, [join(sandboxTests, 'live-quota.test.mjs')], {
      cwd: sandboxDir,
      encoding: 'utf8',
      env: { ...process.env, REAL_LMCTL_BIN: realBin, SKIP_SLOW_SECURITY_TEST: '1' },
      timeout: 60000,
    });
    return {
      code: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      output: (res.stdout || '') + (res.stderr || ''),
    };
  }

  console.log('Running baseline...');
  const baseline = runTest();
  if (baseline.code !== 0) {
    throw new Error(`Baseline failed:\n${baseline.output}`);
  }
  console.log('Baseline PASS: all live-quota tests pass cleanly.\n');

  const mutations = [
    {
      name: 'unreadable quota causes FAIL instead of WARN+run',
      target: 'lms',
      anchor: 'if (unreadable_reason != null) {\n    print("WARN " + provider + ": quota unreadable (" + unreadable_reason + "); proceeding, the call itself is the availability check");\n  }',
      replacement: 'if (unreadable_reason != null) {\n    print("FAIL " + provider + ": quota unreadable (" + unreadable_reason + ")");\n    lm_error("quota unavailable");\n  }',
    },
    {
      name: 'preflight quota error asserts instead of warning',
      target: 'lms',
      anchor: 'if (get(quota, "status", null) != "ok") {\n  print("WARN preflight: rate-limit preflight unreadable (" + str(get(quota, "error", "status not ok")) + "); proceeding");\n  quota = {status: "unreadable", readings: []};\n}',
      replacement: 'assert(quota.status == "ok", "rate-limit preflight failed: " + str(get(quota, "error", null)));',
    },
    {
      name: 'exhausted quota causes FAIL instead of SKIP+WARN',
      target: 'lms',
      anchor: 'if (exhausted_reason != null) {\n    print("WARN " + provider + ": skipped, " + exhausted_reason);\n    record(RESULTS, provider + " available and eligible", true, "skipped: " + exhausted_reason);\n    skipped = skipped + 1;\n    i = i + 1;\n    continue;\n  }',
      replacement: 'if (exhausted_reason != null) {\n    print("FAIL " + provider + ": " + exhausted_reason);\n    record(RESULTS, provider + " available and eligible", false, exhausted_reason);\n    lm_error("provider " + provider + " unavailable: " + exhausted_reason);\n  }',
    },
    {
      name: 'all providers skipped allowed to PASS',
      target: 'lms',
      anchor: 'if (core_ran == 0) {\n  print("FAIL: no core provider (agy or codex) was able to run; all providers skipped or unavailable");\n  record(RESULTS, "at least one core provider ran", false, "0 core providers ran (" + str(skipped) + " skipped)");\n  lm_error("no core provider ran; all providers skipped or unavailable");\n}',
      replacement: 'if (false) {\n  lm_error("no core provider ran; all providers skipped or unavailable");\n}',
    },
    {
      name: 'binary missing softened to warning instead of FAIL',
      target: 'lms',
      anchor: 'if (fail_reason != null) {\n    print("FAIL " + provider + ": " + fail_reason);\n    record(RESULTS, provider + " available and eligible", false, fail_reason);\n    lm_error("provider " + provider + " unavailable: " + fail_reason);\n  }',
      replacement: 'if (fail_reason != null) {\n    print("WARN " + provider + ": " + fail_reason);\n  }',
    },
    {
      name: 'rate-limited prompt treated as failure instead of warning',
      target: 'lms',
      anchor: 'if (get(classification, "isRateLimit", false) == true) {\n      print("WARN " + provider + ": prompt rate-limited / quota exhausted: " + str(result.error));\n      record(RESULTS, provider + " tiny prompt reply", true, "rate-limited: " + str(result.error));\n    } else {',
      replacement: 'if (false) {\n      print("WARN " + provider + ": prompt rate-limited / quota exhausted: " + str(result.error));\n    } else {',
    },
    {
      name: 'model refusal misclassified as rate-limit / warning',
      target: 'classifier',
      anchor: 'if (texts.some(s => isRefusalShaped(s) || isModelRefusal(s, options.modelId))) {\n    return {\n      isRateLimit: false,',
      replacement: 'if (texts.some(s => isRefusalShaped(s) || isModelRefusal(s, options.modelId))) {\n    return {\n      isRateLimit: true,',
    },
    {
      name: 'auth refusal misclassified as rate-limit / warning',
      target: 'classifier',
      anchor: 'if (texts.some(s => isRejectFirst(s) || isStallOrTimeout(s))) {\n    return {\n      isRateLimit: false,',
      replacement: 'if (texts.some(s => isRejectFirst(s) || isStallOrTimeout(s))) {\n    return {\n      isRateLimit: true,',
    },
    {
      name: 'infra error with 429 misclassified as rate-limit (reject-first bypassed in live-probe)',
      target: 'probe',
      anchor: 'const res = classifyProviderFailure(errText, input?.provider);\n  output = { isRateLimit: Boolean(res?.isRateLimit) };',
      replacement: 'output = { isRateLimit: /429|quota|rate/i.test(errText) };',
    },
    {
      name: 'agy 3p bucket treated as gate instead of exempt',
      target: 'lms',
      anchor: 'if (is_agy_3p) {',
      replacement: 'if (false) {',
    },
    {
      name: 'failing difference allowed to pass without failing gate',
      target: 'lms',
      anchor: 'if (failing_diffs > 0) {\n  print("FAIL: " + str(failing_diffs) + " failing difference(s) detected in live suite");\n  lm_exit(1);\n}',
      replacement: 'if (false) {\n  lm_exit(1);\n}',
    },
    {
      name: 'informational declared/observed diff treated as failing difference',
      target: 'lms',
      anchor: 'if (contains(r.name, "observed model matches expectation")) {',
      replacement: 'if (false) {',
    },
  ];

  console.log('| # | Mutation Under Test | Status | Result |');
  console.log('|---|---------------------|--------|--------|');

  let caught = 0;
  for (let i = 0; i < mutations.length; i++) {
    const mut = mutations[i];
    let filePath;
    let originalContent;
    if (mut.target === 'lms') {
      filePath = liveLmsPath;
      originalContent = origLiveLms;
    } else if (mut.target === 'probe') {
      filePath = liveProbePath;
      originalContent = origLiveProbe;
    } else if (mut.target === 'classifier') {
      filePath = classifierPath;
      originalContent = origClassifier;
    }

    if (!originalContent.includes(mut.anchor)) {
      throw new Error(`Anchor not found for mutation "${mut.name}" in target ${mut.target}`);
    }

    const mutatedContent = originalContent.replace(mut.anchor, mut.replacement);
    await writeFile(filePath, mutatedContent, 'utf8');

    const result = runTest();
    // Restore immediately
    await writeFile(filePath, originalContent, 'utf8');

    if (result.code !== 0 && result.output.includes('FAIL')) {
      caught++;
      console.log(`| ${i + 1} | ${mut.name} | CAUGHT | Rejected by test suite (exit code ${result.code}) |`);
    } else {
      console.error(`SURVIVED: Mutation "${mut.name}" was not caught! Exit code: ${result.code}\nOutput:\n${result.output}`);
      throw new Error(`Mutation survived: ${mut.name}`);
    }
  }

  console.log(`\nMutation control complete: ${caught}/${mutations.length} mutations CAUGHT.\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

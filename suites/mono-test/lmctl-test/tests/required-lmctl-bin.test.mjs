import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { requiredLmctlBin } from './required-lmctl-bin.mjs';

function assertDiagnostic(output) {
  assert.match(output, /LMCTL_BIN/);
  assert.match(output, /must resolve to the lmctl binary of an INSTALLED @lmctl-ai\/lmctl/);
  assert.match(output, /not a checkout or a symlink into one/);
  assert.match(output, /npm install --prefix \/tmp\/lmctl-prompt-release/);
  assert.match(output, /LMCTL_BIN=\/tmp\/lmctl-prompt-release\/node_modules\/\.bin\/lmctl node --test lmctl-test\/tests\/prompt-precondition\.test\.mjs/);
}

test('unit: missing and unresolvable LMCTL_BIN name the precondition and invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'required-lmctl-bin-'));
  try {
    const missing = join(root, 'absent');
    const dangling = join(root, 'dangling');
    symlinkSync(missing, dangling);
    for (const value of [undefined, '', missing, dangling]) {
      assert.throws(() => requiredLmctlBin(value), error => {
        assertDiagnostic(error.message);
        return true;
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration: runner names invalid LMCTL_BIN and passes against the installed release', () => {
  const runner = fileURLToPath(new URL('./prompt-precondition.test.mjs', import.meta.url));
  const run = env => {
    const childEnv = { ...env };
    // Start an independent test runner, without inheriting this runner's context.
    delete childEnv.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['--test', runner], {
      env: childEnv, encoding: 'utf8', timeout: 120000,
    });
  };
  const root = mkdtempSync(join(tmpdir(), 'required-lmctl-runner-'));
  try {
    for (const value of [undefined, '', join(root, 'absent')]) {
      const env = { ...process.env };
      if (value === undefined) delete env.LMCTL_BIN;
      else env.LMCTL_BIN = value;
      const result = run(env);
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assertDiagnostic(result.stderr + result.stdout);
    }
    const result = run(process.env);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /INSTALLED @lmctl-ai\/lmctl@/);
    assert.match(result.stdout, /pass 2/);
    assert.match(result.stdout, /fail 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

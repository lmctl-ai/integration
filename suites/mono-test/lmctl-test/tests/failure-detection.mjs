import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'lmctl-test-faults-'));
const bin = process.env.LMCTL_BIN || 'lmctl';
const real = execFileSync('which', [bin], { encoding: 'utf8' }).trim();
const stub = join(root, 'lmctl');
writeFileSync(stub, `#!/bin/sh
if [ "$1" = "$FAULT_COMMAND" ]; then printf 'BROKEN\\n'; exit 0; fi
if [ "$1" = script ] && [ "$2" = tests/read.lms ]; then echo 'injected crash' >&2; exit 7; fi
if [ "$1" = script ]; then printf '1 assertions: 1 pass, 0 fail\\n'; exit 0; fi
exec "$REAL_LMCTL" "$@"
`);
chmodSync(stub, 0o755);

try {
  for (const suite of ['native-session','prompt-heartbeat']) {
    const control = spawnSync(real, ['script', 'tests/' + suite + '.lms', '--negative-control'], {
      cwd: new URL('../', import.meta.url).pathname,
      env: { ...process.env, LMCTL_BIN: real }, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(control.status, 1, suite + ' wrong expectation did not exit 1: ' + control.stdout + control.stderr);
    assert.match(control.stdout, /DIFF.*negative control/);
    assert.match(control.stdout, /1 assertions: 0 pass, 1 fail/);
    console.log('PASS ' + suite + ' checker detects its deliberately wrong expectation');
  }
  for (const command of ['plan', 'lint', 'ls', 'running', 'db', 'init', 'usage', 'prices', 'quickrun', 'tail', 'export', 'cost', 'terminal']) {
    const result = spawnSync(process.execPath, [new URL('offline-commands.mjs', import.meta.url).pathname], {
      env: { ...process.env, LMCTL_BIN: stub, REAL_LMCTL: real, FAULT_COMMAND: command },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `${command} stub passed unexpectedly: ${result.stdout}`);
    console.log(`PASS ${command} assertion detected a stubbed response`);
  }

  const lmscriptBin = process.env.LMSCRIPT_BIN || 'lmscript';
  const realLmscript = lmscriptBin.includes('/') ? lmscriptBin : execFileSync('which', [lmscriptBin], { encoding: 'utf8' }).trim();

  for (const [name, fault] of [['recover-resumepoint', 'IT_MUTATE_RECOVER'], ['doc-examples', 'IT_MUTATE_DOC_EXAMPLES']]) {
    const result = spawnSync(real, ['script', `tests/${name}.lms`], {
      cwd: new URL('../', import.meta.url).pathname,
      env: { ...process.env, LMCTL_BIN: real, LMSCRIPT_BIN: realLmscript, [fault]: '1' },
      encoding: 'utf8', timeout: 180000,
    });
    assert.notEqual(result.status, 0, `${name} injected assertion passed unexpectedly: ${result.stdout}`);
    assert.match(result.stdout, /injected assertion failure/, result.stderr);
    assert.match(result.stdout, /fail/, result.stderr);
    console.log(`PASS ${name} suite detects an injected assertion failure`);
  }

  const runner = spawnSync(real, ['script', 'run-tests.lms', '--ignore-version'], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...process.env, LMCTL_BIN: stub, PATH: `${root}:${process.env.PATH}`, REAL_LMCTL: real },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.notEqual(runner.status, 0, `runner passed unexpectedly: ${runner.stdout}`);
  assert.match(runner.stdout, /read: exit 7/, runner.stderr);
  console.log('PASS runner rejects a child crash without a summary');

  const dryrunFault = spawnSync(real, ['script', 'tests/dryrun-preflight.lms'], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...process.env, LMCTL_BIN: real, FAULT_DRYRUN: '1' },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.notEqual(dryrunFault.status, 0, `dryrun-preflight passed unexpectedly with injected fault: ${dryrunFault.stdout}`);
  console.log('PASS dryrun-preflight negative control detected injected failure');
  for (const suite of [
    { name: 'native-git', fault: 'FAULT_NATIVE_GIT' },
    { name: 'command-literals', fault: 'FAULT_COMMAND_LITERALS' },
    { name: 'graphql-literal', fault: 'FAULT_GRAPHQL' },
    { name: 'schema-import', fault: 'FAULT_SCHEMA_IMPORT' },
    { name: 'pref-overlay', fault: 'FAULT_PREF_OVERLAY' },
    { name: 'schema-nocap', fault: 'FAULT_SCHEMA_NOCAP' },
  ]) {
    const result = spawnSync(real, ['script', `tests/${suite.name}.lms`], {
      cwd: new URL('../', import.meta.url).pathname,
      env: { ...process.env, LMCTL_BIN: real, [suite.fault]: '1' },
      encoding: 'utf8',
      timeout: 120000,
    });
    assert.notEqual(result.status, 0, `${suite.name} negative control passed unexpectedly: ${result.stdout}`);
    assert.match(result.stdout, /differ/, result.stdout);
    console.log(`PASS ${suite.name} assertion detected an injected failure`);
  }

  const prefLiveFault = spawnSync(process.execPath, [new URL('pref-overlay-live.mjs', import.meta.url).pathname, '--mock'], {
    cwd: new URL('../', import.meta.url).pathname,
    env: { ...process.env, LMCTL_BIN: real, FAULT_PREF_OVERLAY: '1' },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.notEqual(prefLiveFault.status, 0, `pref-overlay-live negative control passed unexpectedly: ${prefLiveFault.stdout}`);
  assert.match(prefLiveFault.stderr + prefLiveFault.stdout, /injected assertion failure|AssertionError/, 'must detect failure');
  console.log('PASS pref-overlay-live assertion detected an injected failure');
} finally {
  rmSync(root, { recursive: true, force: true });
}

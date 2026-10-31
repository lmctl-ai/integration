// Negative controls for live hello auth staging; fake credentials are never provider secrets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'installed-cli-hello-quickrun.mjs');
const lmctl = process.env.LMCTL_BIN || 'lmctl';
const root = mkdtempSync(join(tmpdir(), 'lmctl-hello-live-control-'));
const providers = {
  codex: { path: '.codex/auth.json', bad: '{}', error: /lmctl hello exited/ },
  agy: { path: '.gemini/antigravity-cli/antigravity-oauth-token', bad: 'invalid-test-token', error: /lmctl hello exited/ },
};

function run(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function runUntilSignal(env, marker, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
    child.once('error', reject);
    const timer = setInterval(() => {
      if (existsSync(marker)) {
        clearInterval(timer);
        child.kill(signal);
      }
    }, 20);
    const deadline = setTimeout(() => {
      clearInterval(timer);
      child.kill('SIGKILL');
      reject(new Error('live hello control did not create its scratch marker'));
    }, 10000);
    child.once('close', (code, signal) => {
      clearInterval(timer);
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

try {
  const emptyCredentials = join(root, 'empty');
  mkdirSync(emptyCredentials);
  for (const provider of ['codex', 'agy']) {
    const absent = await run({
      LMCTL_BIN: lmctl,
      LMCTL_LIVE_HELLO_PROVIDER: provider,
      LMCTL_HELLO_CREDENTIAL_HOME: emptyCredentials,
    });
    assert.equal(absent.code, 0, absent.stderr);
    assert.match(absent.stdout, new RegExp(`NOTE live hello skipped for ${provider}: missing credential file`));
  }
  console.log('PASS missing credential files skip clearly without provider invocation');

  for (const [provider, config] of Object.entries(providers)) {
    const sourceHome = join(root, `${provider}-source`);
    const source = join(sourceHome, config.path);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, config.bad, { mode: 0o600 });
    chmodSync(source, 0o600);
    const marker = join(root, `${provider}-live-root.txt`);
    const invalid = await run({
      LMCTL_BIN: lmctl,
      LMCTL_LIVE_HELLO_PROVIDER: provider,
      LMCTL_HELLO_CREDENTIAL_HOME: sourceHome,
      LMCTL_HELLO_LIVE_ROOT_MARKER: marker,
    });
    assert.notEqual(invalid.code, 0, `bad ${provider} credentials must fail, stdout=${invalid.stdout}`);
    assert.match(invalid.stderr, config.error, `bad ${provider} credentials must be reported loudly`);
    assert.ok(existsSync(marker), 'live scratch root marker should have been written');
    const scratch = readFileSync(marker, 'utf8');
    assert.ok(scratch.startsWith(`${tmpdir()}/`), `live scratch should retain the established temp location: ${scratch}`);
    assert.equal(existsSync(scratch), false, `${provider} scratch must be removed after failure`);
    console.log(`PASS invalid ${provider} credential copy fails loudly and scratch is removed`);
  }

  const sleeper = join(root, 'lmctl-sleeper');
  writeFileSync(sleeper, `#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='quickrun')console.log('--json\\nvalue with spaces');else if(a[0]==='hello'&&a[1]==='--help')console.log('usage: lmctl hello');else if(a[0]==='hello')setInterval(()=>{},1000);else process.exit(2);\n`);
  chmodSync(sleeper, 0o700);
  const sourceHome = join(root, 'signal-source');
  const source = join(sourceHome, providers.codex.path);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, '{}', { mode: 0o600 });
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const marker = join(root, `${signal}-live-root.txt`);
    const stopped = await runUntilSignal({
      LMCTL_BIN: sleeper,
      LMCTL_LIVE_HELLO_PROVIDER: 'codex',
      LMCTL_HELLO_CREDENTIAL_HOME: sourceHome,
      LMCTL_HELLO_LIVE_ROOT_MARKER: marker,
    }, marker, signal);
    assert.equal(stopped.code, code, stopped.stderr);
    const signalRoot = readFileSync(marker, 'utf8');
    assert.ok(signalRoot.startsWith(`${tmpdir()}/`));
    assert.equal(existsSync(signalRoot), false, `${signal} cleanup must remove live scratch`);
    console.log(`PASS ${signal} exits ${code} and removes live scratch`);
  }
  console.log('5 negative controls passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

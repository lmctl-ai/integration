import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredLmctlBin } from './required-lmctl-bin.mjs';

const suite = dirname(fileURLToPath(import.meta.url));
const bin = requiredLmctlBin(process.env.LMCTL_BIN);
// Fail closed: require a registry install, never a source checkout or global symlink to one.
const pkgRoot = resolve(dirname(bin), '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@lmctl-ai/lmctl');
assert.ok(pkgRoot.includes('/node_modules/@lmctl-ai/lmctl'));
console.log(`INSTALLED ${pkg.name}@${pkg.version}: ${bin}`);
const rejection = "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.";
function sandbox(fn) {
  const root = mkdtempSync(join(tmpdir(), 'prompt-contract-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.lmctl'), { recursive: true });
  writeFileSync(join(home, '.lmctl', 'init.toml'), '[Provider1]\nprovider="ClaudeMock"\nmodel1="mock-default"\nmodel2="mock-default"\nmodel3="mock-default"\n');
  const env = { ...process.env, HOME: home, LMCTL_HOME: join(home, '.lmctl'), LMCTL_DB: join(root, 'state.db'), LMCTL_TEST_ROOT: root,
    LMCTL_LIVE_PROVIDERS: 'codex', LMCTL_ENABLE_MOCK_PROVIDER: '1', LMCTL_CLAUDE_MOCK_STORE: join(root, 'mock.json'),
    PATH: `${dirname(process.execPath)}:${dirname(bin)}:${process.env.PATH}` };
  delete env.CODEX_HOME;
  delete env.LMCTL_TEST_PROMPT_TEAMFILE;
  writeFileSync(env.LMCTL_CLAUDE_MOCK_STORE, JSON.stringify({ schemaVersion: 1, sessions: {} }));
  const run = (script, extra = {}) => spawnSync(bin, ['script', script], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
  try { fn({ root, env, run }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('unit: only the named account/model rejection skips; missing aliases fail closed', () => sandbox(({ root, run }) => {
  const checks = [
    [1, rejection, 'codex', 'gpt-6-luna', '', 'MODEL-UNAVAILABLE'],
    [1, rejection, 'agy', 'gpt-6-luna', '', 'UNSEEDED-ALIAS'],
    [1, rejection, 'codex', 'other-model', '', 'UNSEEDED-ALIAS'],
    [1, '401 unauthorized', 'codex', 'gpt-6-luna', '', 'UNSEEDED-ALIAS'],
    [0, '', 'codex', 'gpt-6-luna', '', 'UNSEEDED-ALIAS'],
    [0, '', 'codex', 'gpt-6-luna', '?', 'UNSEEDED-ALIAS'],
    [0, '', 'codex', 'gpt-6-luna', 'session-123', 'READY'],
  ];
  const script = join(root, 'unit.lms');
  writeFileSync(script, `import ${JSON.stringify(join(suite, 'prompt-precondition.lms'))};\n` + checks.map(([...row]) => {
    const expected = row.pop();
    return `if (prompt_precondition(${row.map(JSON.stringify).join(',')}) != ${JSON.stringify(expected)}) { lm_exit(1); }`;
  }).join('\n') + '\nprint("UNIT CHECKS COMPLETE");');
  const r = run(script);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /UNIT CHECKS COMPLETE/);
  // Pin the production epilogue: printed assertion differences must also fail the process.
  const epilogue = readFileSync(join(suite, 'prompt.lms'), 'utf8').split('differences = summary(RESULTS);')[1];
  for (const ok of [true, false]) {
    writeFileSync(script, `import ${JSON.stringify(join(suite, 'lib.lms'))};\nRESULTS = [{name: "sentinel", ok: ${ok}, detail: "injected"}]; SKIPPED = 0;\ndifferences = summary(RESULTS);${epilogue}`);
    const result = run(script);
    assert.equal(result.status, ok ? 0 : 1, result.stderr + result.stdout);
  }
}));

test('integration: installed script seeds supplied aliases, names skips, and stops broken setup', () => sandbox(({ root, env, run }) => {
  const team = join(root, 'supplied.lmctl');
  const emptyTeam = '_TEAM_ name=prompt-contract\n_MEMBER_ alias=Reviewer1 provider=ClaudeMock model=mock-default\n';
  writeFileSync(team, emptyTeam);
  env.LMCTL_TEST_PROMPT_TEAMFILE = team;
  // Exercise the exact production setup with real installed seed + lm_member, without paid prompt turns.
  const production = readFileSync(join(suite, 'prompt.lms'), 'utf8');
  const setup = join(root, 'setup.lms');
  writeFileSync(setup, production.split('fn prompt_pair(')[0]
    .replace('import "lib.lms";', `import ${JSON.stringify(join(suite, 'lib.lms'))};`)
    .replace('import "prompt-precondition.lms";', `import ${JSON.stringify(join(suite, 'prompt-precondition.lms'))};`) + '\nprint("SETUP COMPLETE " + join(READY, ","));');
  let r = run(setup);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /SETUP COMPLETE codex/);
  assert.match(readFileSync(team, 'utf8'), /sessionid=[^\s]+/);
  // Inject at the subprocess boundary. The installed interpreter and full production script stay real.
  const shimdir = join(root, 'bin'); mkdirSync(shimdir);
  const shim = join(shimdir, 'lmctl');
  writeFileSync(shim, `#!/bin/sh\ncase " $* " in\n*" seed "*) printf '%s\\n' "$SEED_ERROR" >&2; exit "$SEED_EXIT";;\nesac\necho 'UNEXPECTED CLI CALL' >&2; exit 99\n`, { mode: 0o755 });
  const injected = { PATH: `${shimdir}:${env.PATH}`, SEED_EXIT: '1', SEED_ERROR: rejection };
  writeFileSync(team, emptyTeam);
  r = run(join(suite, 'prompt.lms'), injected);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal((r.stdout.match(/^SKIP MODEL-UNAVAILABLE codex /gm) || []).length, 3);
  assert.match(r.stdout, /provider=codex model=gpt-6-luna/);
  assert.match(r.stdout, /SUMMARY: executed=0 skipped=3/);
  console.log("INJECTED MODEL REJECTION:\n" + r.stdout);
  assert.doesNotMatch(r.stderr, /error:|Error Summary/);
  assert.doesNotMatch(r.stderr + r.stdout, /host prompt failed|UNEXPECTED CLI CALL/);
  r = run(join(suite, 'prompt.lms'), { ...injected, SEED_EXIT: '0', SEED_ERROR: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL PRECONDITION UNSEEDED-ALIAS provider=codex alias=Reviewer1/);
  console.log("INJECTED UNSEEDED ALIAS:\n" + r.stdout);
  assert.doesNotMatch(r.stderr + r.stdout, /host prompt failed|UNEXPECTED CLI CALL/);
  r = run(join(suite, 'prompt.lms'), { ...injected, SEED_ERROR: '401 unauthorized' });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /SKIP MODEL-UNAVAILABLE/);
  // Repeat the full affected step against the installed release with the same unavailable capability.
  const first = run(join(suite, 'prompt.lms'), injected);
  const second = run(join(suite, 'prompt.lms'), injected);
  assert.equal(first.status, 0);
  assert.equal(second.status, first.status);
  assert.equal(second.stdout, first.stdout);
  console.log("FINAL REPEAT: two identical MODEL-UNAVAILABLE results, exit=0, executed=0 skipped=3");
  // Mixed capability: intercept only the provider boundary. Real installed seed creates the
  // available provider's mock session; the production setup must still mark it READY.
  writeFileSync(shim, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const file = args.at(-1);
const roster = fs.readFileSync(file, 'utf8');
if (roster.includes('provider=codex')) {
  if (roster.includes('provider=agy')) throw Error('shared roster suppresses available provider');
  console.error(${JSON.stringify(rejection)}); process.exit(1);
}
fs.writeFileSync(file, roster.replace('provider=agy', 'provider=ClaudeMock').replace(/model=.*$/, 'model=mock-default'));
const seeded = cp.spawnSync(${JSON.stringify(bin)}, args, {encoding: 'utf8'});
process.stdout.write(seeded.stdout); process.stderr.write(seeded.stderr); process.exit(seeded.status);
`, { mode: 0o755 });
  r = run(setup, { PATH: injected.PATH, LMCTL_TEST_PROMPT_TEAMFILE: '', LMCTL_LIVE_PROVIDERS: 'codex,agy' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /SKIP MODEL-UNAVAILABLE codex/);
  assert.match(r.stdout, /SETUP COMPLETE agy/);
  assert.match(readFileSync(join(root, '.prompt-live-agy.lmctl'), 'utf8'), /sessionid=[^\s]+/);
  console.log("MIXED CAPABILITY: Codex skipped; Agy independently seeded and READY");
}));

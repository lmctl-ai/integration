// Deterministic integration coverage for the neutral API and both LMScript frontends.
// All provider turns use seeded ClaudeMock sessions; no real provider is contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const tests = join(repo, 'tests');
const bin = process.env.LMCTL_BIN || 'lmctl';
const standalone = process.env.LMSCRIPT_BIN || (existsSync(join(dirname(bin), 'lmscript')) ? join(dirname(bin), 'lmscript') : 'lmscript');
const root = mkdtempSync(join(tmpdir(), 'lmctl-merged-api-'));
const home = join(root, 'home');
const workspace = join(root, 'workspace');
const storePath = join(root, 'claudemock.json');
const dbPath = join(root, 'state.db');
const initDir = join(home, '.lmctl');
const team = join(workspace, 'team.lmctl');
const env = { ...process.env, HOME: home, LMCTL_HOME: initDir, LMCTL_DB: dbPath,
  LMCTL_CLAUDE_MOCK_STORE: storePath, LMCTL_ENABLE_MOCK_PROVIDER: '1',
  LMCTL_NO_UPDATE_NOTIFIER: '1', LMCTL_NON_INTERACTIVE: '1' };
delete env.LMCTL_SELF_SESSIONID;
delete env.LMCTL_INVOCATION_ID;
const replies = {
  API_PROMPT_OK: 'PROMPT_REPLY',
  API_PROMPT_ERROR: { error: 'scripted prompt error' },
  API_AGENT_OK: 'AGENT_REPLY',
  API_FANOUT_A: { text: 'FANOUT_A_REPLY', delayMs: 80 },
  API_FANOUT_B: { text: 'FANOUT_B_REPLY', delayMs: 1 },
  API_BATCH_TURN: 'BATCH_REPLY',
};
const results = [];
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function run(command, args, options = {}) {
  const r = spawnSync(command, args, { cwd: options.cwd ?? workspace, env: { ...env, ...options.env },
    encoding: 'utf8', timeout: options.timeout ?? 90000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', text: (r.stdout ?? '') + (r.stderr ?? '') };
}

function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: String(error) }); console.log(`FAIL ${name}: ${error}`); }
}

function makeEnv() {
  mkdirSync(initDir, { recursive: true }); mkdirSync(workspace, { recursive: true });
  writeFileSync(join(initDir, 'init.toml'), [1,2,3].map(i =>
    `[Provider${i}]\nprovider = "ClaudeMock"\nmodel1 = "mock-default"\nmodel2 = "mock-default"\nmodel3 = "mock-default"\n`).join('\n'));
  writeFileSync(team, '_TEAM_ name=merged-api\n'
    + ['Lead','WorkerA','WorkerB'].map(alias => `_MEMBER_ alias=${alias} provider=ClaudeMock model=mock-default`).join('\n') + '\n');
}

function script(file, extraArgs = [], options = {}) {
  return run(bin, ['script', file, ...extraArgs], options);
}

function mutateContract(source, name) {
  const mutations = {
    prompt: ['lm_prompt(teamfile, "Lead", "API_PROMPT_OK")', 'lm_prompt(teamfile, "MissingAlias", "API_PROMPT_OK")'],
    agent: ['agent = set(lead, "sessiondir", workspace);', 'agent = set(set(lead, "sessiondir", workspace), "sessionid", null);'],
    fanout: ['fanout = lm_fanout(fanout_members, ["API_FANOUT_A", "API_FANOUT_B"]);', 'fanout = [];'],
    batch: ['batch_turn = lm_batch_turn(batch_handle, "API_BATCH_TURN", 1, 1);', 'batch_turn = {status: "error", reply: ""};'],
    sessions: ['delete_result = lm_session_delete(delete_member, {force: true});', 'delete_result = lm_session_delete(delete_member);'],
    ratelimit: ['quota = lm_ratelimit_readings({providers: ["__lmctl-test-unknown__"], timeoutSeconds: 1});', 'quota = {status: "ok", readings: []};'],
  };
  const mutation = mutations[name];
  assert.ok(mutation, `unknown mutation ${name}`);
  assert.ok(source.includes(mutation[0]), `mutation anchor missing: ${name}`);
  return source.replace(mutation[0], mutation[1]);
}

try {
  makeEnv();
  writeFileSync(storePath, JSON.stringify({ schemaVersion: 1, sessions: {}, scriptContains: replies }));
  const seeded = run(bin, ['--non-interactive', 'seed', team], { cwd: workspace });
  assert.equal(seeded.status, 0, seeded.text);
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  const template = Object.values(store.sessions)[0];
  assert.ok(template, `seed did not create a ClaudeMock session: ${seeded.text}`);
  store.sessions = {};
  const members = ['Lead','WorkerA','WorkerB'];
  const sessionIds = Object.fromEntries(members.map(alias => [alias, `lmctl-test-${alias.toLowerCase()}-${process.pid}`]));
  for (const alias of members) {
    const id = sessionIds[alias];
    store.sessions[id] = { ...template, sessionId: id, cwd: workspace, messages: [] };
  }
  writeFileSync(team, '_TEAM_ name=merged-api\n' + members.map(alias =>
    `_MEMBER_ alias=${alias} provider=ClaudeMock model=mock-default sessionid=${sessionIds[alias]} sessiondir=${workspace}`).join('\n') + '\n');
  store.scriptContains = replies;
  writeFileSync(storePath, JSON.stringify(store));

  const contractPath = join(tests, 'merged-api-contract.lms');
  const contractSource = readFileSync(contractPath, 'utf8');
  const mutation = process.env.LMCTL_MERGED_API_MUTATION;
  if (mutation) {
    const mutatedPath = join(root, 'mutated-contract.lms');
    writeFileSync(mutatedPath, mutateContract(contractSource, mutation));
    const mutant = script(mutatedPath, [team, workspace]);
    assert.notEqual(mutant.status, 0, `mutation survived contract: ${mutation}`);
    console.log(`PASS mutation control caught ${mutation}`);
    process.exitCode = 0;
  } else {
    const contract = script(contractPath, [team, workspace]);
    check('neutral lm_* contract under a clean ClaudeMock profile', () => assert.equal(contract.status, 0, contract.text));
    const match = contract.stdout.match(/(\d+) compared: (\d+) agree, (\d+) differ/);
    check('contract assertions produce a zero-difference summary', () => {
      assert.ok(match, contract.text); assert.equal(Number(match[3]), 0, contract.text);
    });

    // Prove each assertion group catches a targeted regression in its exercised contract path.
    for (const name of ['prompt','agent','fanout','batch','sessions','ratelimit']) {
      const mutatedPath = join(root, `mutated-${name}.lms`);
      writeFileSync(mutatedPath, mutateContract(contractSource, name));
      const mutant = script(mutatedPath, [team, workspace]);
      check(`mutation control detects broken ${name} contract`, () => assert.notEqual(mutant.status, 0, mutant.text));
      writeFileSync(storePath, JSON.stringify(store));
    }

    const flags = script(join(tests, 'merged-api-flags.lms'), ['alpha','--json','omega']);
    check('arguments after source preserve --json in args and ARGV', () => {
      assert.equal(flags.status, 0, flags.text);
      assert.deepEqual(JSON.parse(flags.stdout.trim()), { args: ['alpha','--json','omega'], ARGV: ['alpha','--json','omega'] });
    });
    const flagsControl = script(join(tests, 'merged-api-flags.lms'), ['alpha','omega']);
    check('argument control detects a missing --json tail', () => {
      assert.notDeepEqual(JSON.parse(flagsControl.stdout.trim()), { args: ['alpha','--json','omega'], ARGV: ['alpha','--json','omega'] });
    });

    const noProfile = join(root, 'no-profile'); mkdirSync(noProfile);
    const noProfileEnv = { ...env, HOME: noProfile, LMCTL_HOME: join(noProfile, '.lmctl'), LMCTL_DB: '' };
    const checkClean = run(standalone, ['--check',join(tests,'merged-api-flags.lms')], { env: noProfileEnv });
    check('--check parses without a profile', () => assert.equal(checkClean.status, 0, checkClean.text));
    const badSyntax = join(root, 'bad-syntax.lms'); writeFileSync(badSyntax, 'if (\n');
    const checkBad = run(standalone, ['--check',badSyntax], { env: noProfileEnv });
    check('--check reports syntax errors with exit 2 and no profile', () => assert.equal(checkBad.status, 2, checkBad.text));

    const parity = join(tests, 'merged-api-parity.lms');
    const cliParity = script(parity, [team, workspace]);
    const standaloneParity = run(standalone,
      [parity,team,workspace]);
    check('standalone built-ins match lmctl script for shared API results', () => {
      assert.equal(cliParity.status, 0, cliParity.text);
      assert.equal(standaloneParity.status, 0, standaloneParity.text);
      const cliResult = JSON.parse(cliParity.stdout.trim());
      const standaloneResult = JSON.parse(standaloneParity.stdout.trim());
      assert.deepEqual(standaloneResult.members, cliResult.members);
      assert.deepEqual(standaloneResult.member, cliResult.member);
      assert.deepEqual(standaloneResult.session_ids, cliResult.session_ids);
      assert.deepEqual(standaloneResult.quota, cliResult.quota);
      assert.deepEqual(cliResult.shapes, {members:'api-envelope',member:'api-envelope',sessions:'api-envelope'});
      assert.deepEqual(standaloneResult.shapes, {members:'api-envelope',member:'api-envelope',sessions:'api-envelope'});
    });
    const mutatedParity = join(root, 'mutated-parity.lms');
    const paritySource = readFileSync(parity, 'utf8').replace('members_raw = lm_members(teamfile);', 'members_raw = lm_members_missing(teamfile);');
    assert.notEqual(paritySource, readFileSync(parity, 'utf8'), 'parity mutation anchor missing');
    writeFileSync(mutatedParity, paritySource);
    const parityControl = run(standalone,
      [mutatedParity,team,workspace]);
    check('parity control fails when the shared API call is removed', () => assert.notEqual(parityControl.status, 0, parityControl.text));

    const sessionErrorParity = join(root, 'mutated-parity-session-error.lms');
    const sessionErrorSource = readFileSync(parity, 'utf8').replace(
      'sessions_raw = lm_session_list({provider: "codex", sessiondir: workspace, all: true});',
      'sessions_raw = {status:"error",error:"fixture listing error",sessions:[]};'
    );
    assert.notEqual(sessionErrorSource, readFileSync(parity, 'utf8'), 'session listing mutation anchor missing');
    writeFileSync(sessionErrorParity, sessionErrorSource);
    const sessionControlCli = script(sessionErrorParity, [team, workspace]);
    const sessionControlStandalone = run(standalone, [sessionErrorParity, team, workspace]);
    check('parity control fails when session listing returns an error map', () => {
      assert.notEqual(sessionControlCli.status, 0, 'CLI did not reject session error map in parity');
      assert.notEqual(sessionControlStandalone.status, 0, 'Standalone did not reject session error map in parity');
    });

    const epipe = run('bash', ['-c', `set -o pipefail; ${quote(bin)} script ${quote(join(tests,'merged-api-epipe.lms'))} | head -c 1 >/dev/null`]);
    check('script piped to head exits quietly on EPIPE', () => {
      assert.equal(epipe.status, 0, epipe.text); assert.doesNotMatch(epipe.stderr, /EPIPE|write after end/);
    });
    const brokenEpipeBin = join(root, 'lmctl-epipe-mutation');
    writeFileSync(brokenEpipeBin, '#!/bin/sh\nprintf x\nexit 141\n', { mode: 0o755 });
    const epipeControl = run('bash', ['-c', `set -o pipefail; ${quote(brokenEpipeBin)} script ${quote(join(tests,'merged-api-epipe.lms'))} | head -c 1 >/dev/null`], { env: { REAL_LMCTL: bin } });
    check('EPIPE failing control detects a runner that exits 141', () => assert.notEqual(epipeControl.status, 0));

    console.log('Live checks are in merged-api-live.mjs; run with --live and LMCTL_TEST_LIVE=1.');
  }

  const passed = results.filter(result => result.ok).length;
  const failed = results.length - passed;
  console.log(`${results.length} assertions: ${passed} pass, ${failed} fail`);
  if (failed) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}

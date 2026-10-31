// Live LLM coverage for issue 067: lmscript --pref overlay across both frontends.
// This module is skipped unless LMCTL_TEST_LIVE=1 or --mock is passed.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve as liveResolve } from '../../live-config.mjs';

const mock = process.argv.includes('--mock');
if (process.env.LMCTL_TEST_LIVE !== '1' && !mock) {
  console.log('SKIP live pref overlay suite (set LMCTL_TEST_LIVE=1)');
  console.log('0 assertions: 0 pass, 0 fail');
  process.exit(0);
}

const lmctlBin = process.env.LMCTL_BIN || 'lmctl';
let lmscriptBin = process.env.LMSCRIPT_BIN;
if (!lmscriptBin) {
  const sibling = join(dirname(resolve(lmctlBin)), 'lmscript');
  if (existsSync(sibling)) lmscriptBin = sibling;
  else lmscriptBin = 'lmscript';
}

function checkRateLimit(provider) {
  try {
    const raw = execFileSync(lmctlBin, ['ratelimit', provider, '--json'], {
      encoding: 'utf8',
      timeout: 30000,
      env: process.env,
    });
    const parsed = JSON.parse(raw);
    const reading = parsed.readings?.find(r => r.provider === provider);
    if (!reading || reading.status !== 'ok') {
      return { ok: false, reason: 'quota reading unavailable or not ok' };
    }
    if (reading.ordinary_usage_allowed === false) {
      return { ok: false, reason: 'ordinary usage disallowed' };
    }
    if (reading.spend_control?.reached) {
      return { ok: false, reason: 'spend control reached' };
    }
    const buckets = reading.buckets || [];
    for (const bucket of buckets) {
      const bucketId = String(bucket.bucket_id || '');
      // Operator decision 2026-10-07: agy 3p bucket is never used by tests, so it never gates.
      if (provider === 'agy' && (bucketId.startsWith('3p') || bucketId.startsWith('agy-3p'))) {
        continue;
      }
      if (bucket.is_exhausted || bucket.limit_reached || bucket.allowed === false ||
          (bucket.used_fraction != null && bucket.used_fraction >= 1)) {
        return { ok: false, reason: `exhausted or disallowed bucket ${bucketId}` };
      }
    }
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `ratelimit query failed: ${err.message}` };
  }
}

const configured = Object.fromEntries(
  liveResolve(JSON.parse(readFileSync(process.env.LMCTL_LIVE_CONFIG || new URL('../../live-config.json', import.meta.url), 'utf8')), {})
    .map(p => [p.id, p.model])
);

const allLiveProviders = [
  ['codex', process.env.LMCTL_LIVE_CODEX_MODEL || configured.codex || 'gpt-6-luna'],
  ['agy', process.env.LMCTL_LIVE_AGY_MODEL || configured.agy || 'Gemini 3.8 Flash (Medium)'],
];

const requestedEnv = (process.env.LMCTL_LIVE_PROVIDERS || 'codex,agy')
  .split(',')
  .map(p => p.trim().toLowerCase())
  .filter(Boolean);

const providersToTest = mock
  ? [['codex', 'gpt-6-luna']]
  : allLiveProviders.filter(([p]) => requestedEnv.includes(p));

let passed = 0;
let attemptedCount = 0;
let completedCount = 0;
let skippedCount = 0;

for (const [provider, model] of providersToTest) {
  attemptedCount++;
  if (!mock) {
    const preflight = checkRateLimit(provider);
    if (!preflight.ok) {
      console.log(`NOTE live pref overlay skipped for ${provider}: rate-limited (${preflight.reason})`);
      skippedCount++;
      continue;
    }
  }

  const root = mkdtempSync(join(tmpdir(), `lmctl-pref-live-${provider}-`));
  try {
    const home = join(root, 'home');
    const lmctlHome = join(home, '.lmctl');
    const work = join(root, 'work');
    const db = join(root, 'state.db');
    const mockStore = join(root, 'mock.json');
    const prefFile = join(root, 'pref.toml');
    const scriptFile = join(work, 'test-pref.lms');

    mkdirSync(lmctlHome, { recursive: true });
    mkdirSync(work, { recursive: true });

    // Mock store for offline control turns
    writeFileSync(mockStore, JSON.stringify({
      schemaVersion: 1,
      sessions: {},
      scriptContains: { ACK: 'ACK', LIVE_PREF_OK: 'LIVE_PREF_OK' },
    }));

    // Base init.toml in isolated HOME: points Provider1 to an offline mock
    const baseProvider = 'ClaudeMock';
    const baseModel = 'mock-base';
    writeFileSync(join(lmctlHome, 'init.toml'), [
      '[Provider1]',
      `provider = "${baseProvider}"`,
      `model1 = "${baseModel}"`,
      `model2 = "${baseModel}"`,
      `model3 = "${baseModel}"`,
    ].join('\n') + '\n');

    // Overlay pref file: overrides Provider1 to live provider + model
    const overlayProvider = mock ? 'ClaudeMock' : provider;
    const overlayModel = mock ? 'mock-overlay' : model;
    writeFileSync(prefFile, [
      '[Provider1]',
      `provider = "${overlayProvider}"`,
      `model1 = "${overlayModel}"`,
    ].join('\n') + '\n');

    // The test script executed by both frontends:
    // Builds a teamfile from PROPS.Provider1, seeds on first use, and executes one prompt.
    writeFileSync(scriptFile, [
      'p = PROPS.Provider1.Provider;',
      'm = PROPS.Provider1.Model1;',
      'safe_m = regex_replace(m, "[^A-Za-z0-9_-]", "_");',
      'teamdir = path_join(Directory, p + "_" + safe_m);',
      'mkdir(teamdir);',
      'teamfile = path_join(teamdir, "pref-team.lmctl");',
      'if (!file_exists(teamfile)) {',
      '  write_file(teamfile, "_TEAM_ name=pref-live\\n_MEMBER_ alias=Lead provider=" + json_stringify(p) + " model=" + json_stringify(m) + "\\n");',
      '  s = lm_seed(teamfile);',
      '  require(s.status == "ok", "seed: " + str(s.error));',
      '}',
      'r = lm_prompt(teamfile, "Lead", "Reply with the single word ACK. Do not use tools or read or change files.", {idleTimeoutMs: 120000});',
      'require(r.status == "ok", "prompt: " + str(r.error));',
      'require(len(trim(r.reply)) > 0, "reply is empty");',
      'println("JSON_RESULT:" + json_stringify({',
      '  status: r.status,',
      '  reply: trim(r.reply),',
      '  team_chat_log_id: r.team_chat_log_id,',
      '  provider: p,',
      '  model: m',
      '}));',
    ].join('\n') + '\n');

    const env = {
      ...process.env,
      LMCTL_HOME: lmctlHome,
      LMCTL_DB: db,
      LMCTL_NON_INTERACTIVE: '1',
      LMCTL_NO_UPDATE_NOTIFIER: '1',
      LMCTL_ENABLE_MOCK_PROVIDER: '1',
      LMCTL_CLAUDE_MOCK_STORE: mockStore,
      TZ: 'UTC',
      LC_ALL: 'C',
    };
    for (const key of Object.keys(env)) {
      if (['LMCTL_SELF_SESSIONID', 'LMCTL_INVOCATION_ID', 'LMBEE_TEAM_NAME', 'LMCTL_SELF_TEAMFILE', 'LMCTL_SELF_ALIAS'].includes(key)) {
        delete env[key];
      }
    }

    function extractJsonResult(stdout) {
      for (const line of stdout.split('\n')) {
        if (line.startsWith('JSON_RESULT:')) {
          return JSON.parse(line.slice('JSON_RESULT:'.length));
        }
      }
      throw new Error(`missing JSON_RESULT in stdout:\n${stdout}`);
    }

    // 1. Frontend 1: lmscript with --pref
    const run1 = spawnSync(lmscriptBin, ['--pref', prefFile, scriptFile], {
      cwd: work, env, encoding: 'utf8', timeout: 300000,
    });
    assert.equal(run1.status, 0, `lmscript --pref failed:\nstdout: ${run1.stdout}\nstderr: ${run1.stderr}`);
    const res1 = extractJsonResult(run1.stdout);
    assert.equal(res1.status, 'ok', 'lmscript status must be ok');
    assert.ok(res1.reply.length > 0, 'lmscript reply must be non-empty');
    passed += 2;

    const db1 = new DatabaseSync(db, { readOnly: true });
    let row1;
    try {
      row1 = db1.prepare('SELECT id, provider, model_requested, model_reported FROM team_chat_log WHERE id = ?').get(res1.team_chat_log_id);
    } finally { db1.close(); }
    assert.ok(row1, 'team_chat_log row must exist for lmscript run');
    assert.equal(row1.provider, overlayProvider, 'team_chat_log provider must match overlay');
    assert.equal(row1.model_requested, overlayModel, 'team_chat_log model must match overlay');
    passed += 3;

    // 2. Frontend 2: lmctl script with --pref
    const run2 = spawnSync(lmctlBin, ['script', '--pref', prefFile, scriptFile], {
      cwd: work, env, encoding: 'utf8', timeout: 300000,
    });
    assert.equal(run2.status, 0, `lmctl script --pref failed:\nstdout: ${run2.stdout}\nstderr: ${run2.stderr}`);
    const res2 = extractJsonResult(run2.stdout);
    assert.equal(res2.status, 'ok', 'lmctl script status must be ok');
    assert.ok(res2.reply.length > 0, 'lmctl script reply must be non-empty');
    passed += 2;

    const db2 = new DatabaseSync(db, { readOnly: true });
    let row2;
    try {
      row2 = db2.prepare('SELECT id, provider, model_requested, model_reported FROM team_chat_log WHERE id = ?').get(res2.team_chat_log_id);
    } finally { db2.close(); }
    assert.ok(row2, 'team_chat_log row must exist for lmctl script run');
    assert.equal(row2.provider, overlayProvider, 'team_chat_log provider must match overlay');
    assert.equal(row2.model_requested, overlayModel, 'team_chat_log model must match overlay');
    passed += 3;

    // 3. CONTROL: run the same script WITHOUT --pref (spends 0 quota)
    const runControl = spawnSync(lmscriptBin, [scriptFile], {
      cwd: work, env, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(runControl.status, 0, `control without --pref failed:\nstdout: ${runControl.stdout}\nstderr: ${runControl.stderr}`);
    const resControl = extractJsonResult(runControl.stdout);
    assert.equal(resControl.status, 'ok', 'control run status must be ok');
    passed += 2;

    const dbC = new DatabaseSync(db, { readOnly: true });
    let rowC;
    try {
      rowC = dbC.prepare('SELECT id, provider, model_requested, model_reported FROM team_chat_log WHERE id = ?').get(resControl.team_chat_log_id);
    } finally { dbC.close(); }
    assert.ok(rowC, 'control team_chat_log row must exist');
    assert.equal(rowC.provider, baseProvider, 'control without --pref must resolve to base provider');
    if (!mock) {
      assert.notEqual(rowC.provider, provider, 'control without --pref must differ from live overlay provider');
    } else {
      assert.equal(rowC.model_requested, baseModel, 'mock control must resolve to base model');
      assert.notEqual(rowC.model_requested, overlayModel, 'mock control must differ from overlay model');
    }
    passed += 3;

    // Failure-detection negative control injection
    if (process.env.FAULT_PREF_OVERLAY === '1') {
      assert.equal(row1.provider, 'INJECTED_FAULT_PROVIDER', 'injected assertion failure for failure-detection control');
    }

    // Quota and transcript accounting
    const dbUsage = new DatabaseSync(db, { readOnly: true });
    let usageSummary = [];
    try {
      usageSummary = dbUsage.prepare('SELECT provider, model, tok_input_uncached, tok_output, billed_tokens, cost_usd FROM turn_usage WHERE provider = ?').all(overlayProvider);
    } finally { dbUsage.close(); }

    const totalBilledTokens = usageSummary.reduce((acc, row) => acc + (Number(row.billed_tokens) || 0), 0);
    const totalCostUsd = usageSummary.reduce((acc, row) => acc + (Number(row.cost_usd) || 0), 0);

    completedCount++;
    console.log(`PASS ${provider} ${model}: lmscript and lmctl script both ran through --pref overlay`);
    console.log(`  lmscript reply: ${JSON.stringify(res1.reply)} (tcl_id=${res1.team_chat_log_id})`);
    console.log(`  lmctl reply:    ${JSON.stringify(res2.reply)} (tcl_id=${res2.team_chat_log_id})`);
    console.log(`  quota used:     ${usageSummary.length} turn(s), ${totalBilledTokens} billed tokens, USD ${totalCostUsd.toFixed(6)}`);
    console.log(`CONTROL ${provider}: without --pref resolved to base provider ${baseProvider} (0 quota spent)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (attemptedCount > 0 && completedCount === 0 && skippedCount === attemptedCount) {
  console.log('NOTE all attempted live providers were rate-limited and skipped');
}

console.log(`${passed} assertions: ${passed} pass, 0 fail`);

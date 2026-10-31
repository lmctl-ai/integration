import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** Actual CLI/process/file/DB integration. Catalog fixtures are deterministic;
 * a tripwire records provider dispatch and deliberately fails instead of calling AI.
 * Interactive cases change only stdin's TTY marker in a child preload. */
export function runIntentCases({ root, env, bin, check }) {
  const fixture = join(root, 'intent-cases');
  const providers = join(fixture, 'bin');
  const callsFile = join(fixture, 'provider-calls.jsonl');
  const preload = join(fixture, 'tty.cjs');
  mkdirSync(providers, { recursive: true });
  symlinkSync(process.execPath, join(providers, 'node'));
  writeFileSync(preload, "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n");
  const cli = realpathSync(isAbsolute(bin) || bin.includes('/') ? resolve(bin)
    : (env.PATH || '').split(delimiter).map((dir) => join(dir, bin)).find(existsSync));
  const isolated = { ...env, PATH: providers, LMCTL_PRICE_DATA: fixture, LMCTL_HOME: join(fixture, 'lmctl-home'),
    LMCTL_NO_UPDATE_NOTIFIER: '1', LMCTL_LMBEE_BRIDGE: '0',
    KIMI_CODE_HOME: join(fixture, 'kimi'), CODEX_HOME: join(fixture, 'codex'),
    HERMES_HOME: join(fixture, 'hermes'), XDG_CONFIG_HOME: join(fixture, 'config'),
    XDG_DATA_HOME: join(fixture, 'data'), INTENT_PROVIDER_CALLS: callsFile };
  for (const key of ['LMCTL_SELF_SESSIONID', 'LMCTL_INVOCATION_ID', 'LMCTL_DEBUG', 'NODE_OPTIONS']) delete isolated[key];
  mkdirSync(isolated.KIMI_CODE_HOME, { recursive: true });
  writeFileSync(join(isolated.KIMI_CODE_HOME, 'config.toml'), '[models."shared-fixture"]\nprovider="fixture"\nmodel="fixture"\n');
  const modelNames = ['claude-fixture-1', 'claude-fixture-1-2', 'claude-fixture-2'];
  writeFileSync(join(fixture, 'model_list.json'), JSON.stringify({ schema_version: 1,
    generated_at: '2026-10-01T00:00:00Z', records: modelNames.map((source_model_id) => ({
      source: 'litellm', source_model_id, provider: 'anthropic', mode: 'chat',
      pricing: { input_per_1m_tokens: 0, output_per_1m_tokens: 3, input_cache_read_per_1m_tokens: null },
    })) }));
  writeFileSync(join(fixture, 'aliases.json'), JSON.stringify({ schema_version: 1, standards: [], aliases: [] }));
  const tripwire = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const provider = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }
if (provider === 'codex' && argv[0] === 'debug' && argv[1] === 'models') {
  console.log(JSON.stringify({ models: [{slug:'shared-fixture',visibility:'list'}] })); process.exit(0);
}
if (provider === 'agy' && argv[0] === 'models') { console.log('fixture\\tUnpriced Fixture'); process.exit(0); }
function record(event) { fs.appendFileSync(process.env.INTENT_PROVIDER_CALLS, JSON.stringify({provider, ...event}) + '\\n'); }
record({event:'start', argv, cwd:process.cwd()});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.includes('\\n')) {
    record({event:'input', text:input});
    process.stderr.write('INTENT_PROVIDER_TRIPWIRE\\n'); process.exit(37);
  }
});
setTimeout(() => { record({event:'input',text:input}); process.stderr.write('INTENT_PROVIDER_TRIPWIRE\\n'); process.exit(37); }, 500);
`;
  for (const name of ['claude', 'codex', 'agy', 'kimi']) {
    const path = join(providers, name); writeFileSync(path, tripwire); chmodSync(path, 0o755);
  }
  let caseNo = 0;
  function workspace() {
    const dir = join(fixture, `case-${++caseNo}`); mkdirSync(dir, { recursive: true }); return dir;
  }
  function calls() {
    return existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  }
  // The lmscript engine reads ~/.lmctl/init.toml when it starts (a missing file is a start-up error, since
  // lmctl 0.2.38). Only calls that execute a script get a profile, and only for that call, so the other cases
  // (hello, plan, lint) keep seeing the profile-free state they assert on.
  const profile = join(isolated.LMCTL_HOME, 'init.toml');
  const runsScript = (args) => args[0] === 'script' || args[0] === 'quickrun' || args.some((a) => /\.lms$/i.test(a));
  function withScriptProfile(args, fn) {
    if (!runsScript(args) || existsSync(profile)) return fn();
    mkdirSync(isolated.LMCTL_HOME, { recursive: true });
    writeFileSync(profile, [1, 2, 3].map((i) => `[Provider${i}]\nprovider = "agy"\nmodel1 = "m1"\nmodel2 = "m2"\nmodel3 = "m3"\n`).join('\n'));
    try { return fn(); } finally { rmSync(profile, { force: true }); }
  }
  function run(argv, { cwd = fixture, tty = false, input = '' } = {}) {
    assert.equal(argv[0], 'lmctl');
    const result = withScriptProfile(argv.slice(1), () => spawnSync(process.execPath, [...(tty ? ['--require', preload] : []), cli, ...argv.slice(1)],
      { cwd, env: isolated, input, encoding: 'utf8', timeout: 20000 }));
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  }
  function noDispatch() { assert.equal(calls().length, 0, 'a read/decline/invalid-input path invoked a provider'); }
  function test(name, fn) {
    check(`intent: ${name}`, () => { rmSync(callsFile, { force: true }); fn(); });
  }
  function nativeSession({ ageDays = 1, context = 42, active = false } = {}) {
    const id = randomUUID();
    const cwd = workspace();
    const dir = join(env.HOME, '.claude', 'projects', 'intent-fixtures'); mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    const timestamp = new Date(Date.now() - ageDays * 86400000).toISOString();
    writeFileSync(file, [
      { type: 'user', sessionId: id, cwd, timestamp, message: { content: 'fixture input' } },
      { type: 'assistant', sessionId: id, cwd, timestamp, message: {
        model: modelNames[0], content: [{ type: 'text', text: 'fixture output' }],
        stop_reason: active ? 'tool_use' : 'end_turn',
        usage: { input_tokens: context, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 4 },
      } },
    ].map(JSON.stringify).join('\n') + '\n');
    return { id, cwd, file };
  }
  function team(cwd, name = 'T.lmc', members = [{ alias: 'Lead', id: randomUUID() }]) {
    const file = join(cwd, name);
    writeFileSync(file, '# keep these notes\n' + members.map((m) =>
      `_MEMBER_ provider=claude alias=${m.alias} model=${m.model || modelNames[0]}${m.id ? ` sessionid=${m.id}` : ''}${m.cwd ? ` sessiondir="${m.cwd}"` : ''}`,
    ).join('\n') + '\n');
    return file;
  }
  function dispatchedText() {
    return calls().filter((c) => c.event === 'input').flatMap((c) => c.text.trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line)?.message?.content ?? ''; } catch { return ''; }
    })).join('\n');
  }

  test('global non-interactive and JSON modes never ask for missing input even in a TTY', () => {
    for (const args of [
      ['lmctl', '--non-interactive', 'prompt'],
      ['lmctl', 'prompt', '--json'],
      ['lmctl', '--non-interactive', 'plan', '--wizard'],
    ]) {
      const r = run(args, { cwd: workspace(), tty: true, input: 'answers must not be consumed\n' });
      assert.equal(r.status, 2); noDispatch();
    }
  });
  test('hello without arguments lists the hosted examples without prompting or dispatching', () => {
    const cwd = workspace(); const r = run(['lmctl', 'hello'], { cwd, tty: true, input: '' });
    assert.match(r.stdout + r.stderr, /hello examples|hosted|could not fetch/i); noDispatch();
  });
  test('omitted models lint as provider defaults without warnings', () => {
    const cwd = workspace(); const file = join(cwd, 'default.lmc');
    writeFileSync(file, '_MEMBER_ provider=agy alias=Lead\n');
    const r = run(['lmctl', 'lint', file], { cwd });
    assert.equal(r.status, 0); assert.doesNotMatch(r.stderr, /warning:/); noDispatch();
  });
  test('non-interactive script mode rejects human input but --json script arguments remain literal', () => {
    const cwd = workspace(); const file = join(cwd, 'interactive.lms');
    writeFileSync(file, 'println(prompt_human("Question?"));');
    const blocked = run(['lmctl', '--non-interactive', file], { cwd, tty: true, input: 'not an answer\n' });
    assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /disabled in non-interactive mode/);
    writeFileSync(file, 'println(args[0]); println(env("LMCTL_NON_INTERACTIVE", "human"));');
    const data = run(['lmctl', file, '--json'], { cwd });
    assert.equal(data.status, 0); assert.equal(data.stdout, '--json\nhuman\n'); noDispatch();
  });
  test('script shorthand executes relative files and passes flags as literal arguments', () => {
    const file = join(root, 'example with spaces.LMS');
    writeFileSync(file, 'println(args[0]); println(args[1]); println(args[2]);');
    const r = run(['lmctl', 'example with spaces.LMS', '--force', '--debug', 'hello world'], { cwd: root });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '--force\n--debug\nhello world\n');
  });
  test('script shorthand reports missing files and preserves script exit codes', () => {
    assert.notEqual(run(['lmctl', 'missing.lms']).status, 0);
    const file = join(root, 'exit.lms');
    writeFileSync(file, 'lm_exit(7);');
    assert.equal(run(['lmctl', 'exit.lms'], { cwd: root }).status, 7);
  });
  test('no arguments show help without provider calls', () => {
    const r = run(['lmctl']); assert.equal(r.status, 0); assert.match(r.stdout, /Partial input/); noDispatch();
  });
  test('exact models command retains JSON behavior (issue 084)', () => {
    const r = run(['lmctl', 'models', 'codex', '--json']); assert.equal(r.status, 0);
    const model = JSON.parse(r.stdout).providers[0].models[0];
    assert.equal(model.id, 'shared-fixture');
    assert.equal(model.status, 'valid');
    assert.notEqual(model.status, 'unverified');
    noDispatch();
  });
  test('provider prefixes and provider/model queries only list matching prices', () => {
    for (const target of ['clau', 'claude/claude-fixture-1']) {
      const r = run(['lmctl', target]); assert.equal(r.status, 0);
      assert.match(r.stdout, /claude-fixture-1\s+unverified\s+\$0\s+\$3\s+n\/a/);
      assert.doesNotMatch(r.stdout, /claude-fixture-1\s+valid\b/);
      if (target.includes('/')) assert.doesNotMatch(r.stdout, /claude-fixture-1-2/);
    }
    noDispatch();
  });
  test('ambiguous model names can be listed but cannot silently choose a prompt destination', () => {
    const query = run(['lmctl', 'shared-fixture']); assert.equal(query.status, 0);
    assert.match(query.stdout, /codex/); assert.match(query.stdout, /kimi/);
    const prompt = run(['lmctl', 'shared-fixture', 'do this task']); assert.equal(prompt.status, 2);
    assert.match(prompt.stderr, /Choose|More information/); noDispatch();
  });
  test('all force/yes spellings fail before touching a missing teamfile', () => {
    const cwd = workspace(); const file = join(cwd, 'absent.lmc');
    for (const flag of ['--force', '--yes', '-f', '-y']) {
      const r = run(['lmctl', file, flag], { cwd, input: 'yes\n' }); assert.equal(r.status, 2);
      assert.match(r.stderr, /Force\/yes/); assert.equal(existsSync(file), false);
    }
    noDispatch();
  });
  test('permission flags are never swallowed into prompt text', () => {
    const cwd = workspace(); const file = join(cwd, 'absent.lmc');
    const r = run(['lmctl', `${file}:Lead`, 'edit these files', '--permission-mode', 'plan'], { cwd });
    assert.equal(r.status, 2); assert.match(r.stderr, /explicit command for options/);
    assert.equal(existsSync(file), false); noDispatch();
  });
  test('piped answers cannot bypass interactive completion', () => {
    const cwd = workspace(); const file = join(cwd, 'absent.lmc');
    const r = run(['lmctl', file], { cwd, input: 'Lead\nclaude\nclaude-fixture-1\nyes\n' });
    assert.equal(r.status, 2); assert.equal(existsSync(file), false); noDispatch();
  });
  test('EOF during partial completion preserves the original file', () => {
    const cwd = workspace(); const file = join(cwd, 'partial.lmc'); const original = '# keep\n_MEMBER_ provider=claude\n';
    writeFileSync(file, original);
    const r = run(['lmctl', file], { cwd, tty: true, input: 'Lead\n' });
    assert.equal(r.status, 2); assert.match(r.stderr, /Input ended/);
    assert.equal(readFileSync(file, 'utf8'), original); noDispatch();
  });
  test('completing a partial plan preserves notes and attempts only the requested seed', () => {
    const cwd = workspace(); const file = join(cwd, 'partial.lmc');
    writeFileSync(file, '# keep\n_MEMBER_ provider=claude\n');
    const r = run(['lmctl', file], { cwd, tty: true, input: 'Lead\nclaude-fixture-1\n' });
    assert.notEqual(r.status, 0); // deliberate provider tripwire, not a successful AI seed
    const text = readFileSync(file, 'utf8');
    assert.match(text, /# keep/); assert.match(text, /alias=Lead/); assert.match(text, /model=claude-fixture-1/);
    assert.doesNotMatch(text, /sessionid=/);
    assert.equal(calls().filter((c) => c.event === 'start').length, 1);
  });
  test('both extensions, uppercase suffixes, spaces and alias prefixes resolve without writes', () => {
    const cwd = workspace();
    for (const name of ['space team.lmc', 'team.lmctl', 'upper.LMC']) {
      const file = team(cwd, name, [{ alias: 'Lead', id: randomUUID() }, { alias: 'Reviewer', id: randomUUID() }]);
      const original = readFileSync(file, 'utf8');
      for (const args of [[file, 'reviewer'], [`${file}:Rev`]]) {
        const r = run(['lmctl', ...args], { cwd }); assert.equal(r.status, 0);
        assert.match(r.stdout, /Reviewer/); assert.doesNotMatch(r.stdout, /\bLead\b/);
        assert.equal(readFileSync(file, 'utf8'), original);
      }
    }
    noDispatch();
  });
  test('unknown aliases and unfinished colon aliases ask rather than pick a member', () => {
    const cwd = workspace(); const file = team(cwd, 'T.lmc', [{ alias: 'Lead', id: randomUUID() }, { alias: 'Linter', id: randomUUID() }]);
    for (const target of [`${file}:`, `${file}:L`, `${file}:Missing`]) {
      const r = run(['lmctl', target], { cwd }); assert.equal(r.status, 2); assert.match(r.stderr, /Choose|More information/);
    }
    noDispatch();
  });
  test('missing batch files and empty batch files never dispatch', () => {
    const cwd = workspace(); const file = join(cwd, 'B.lmb');
    let r = run(['lmctl', file], { cwd }); assert.equal(r.status, 2); assert.match(r.stderr, /not found/);
    writeFileSync(file, '\n\n'); r = run(['lmctl', file], { cwd }); assert.equal(r.status, 2); assert.match(r.stderr, /no prompts/); noDispatch();
  });
  test('both batch shorthand forms refuse an unresolved destination without a terminal', () => {
    const cwd = workspace(); const file = join(cwd, 'B.lmb'); writeFileSync(file, 'first request\n\nsecond request');
    for (const argv of [['lmctl', file], ['lmctl', 'batch', file]]) {
      const r = run(argv, { cwd, input: 'T.lmc\nLead\n' }); assert.equal(r.status, 2);
      assert.match(r.stderr, /Teamfile path/); assert.equal(existsSync(join(cwd, 'T.lmc')), false);
    }
    noDispatch();
  });
  test('batch shorthand sends the first paragraph and stops on provider failure', () => {
    const cwd = workspace(); const native = nativeSession();
    team(cwd, 'T.lmc', [{ alias: 'Lead', id: native.id, cwd: native.cwd }]);
    const file = join(cwd, 'B.lmb'); writeFileSync(file, 'FIRST BATCH SENTINEL\n\nSECOND BATCH SENTINEL');
    const r = run(['lmctl', file], { cwd }); assert.notEqual(r.status, 0);
    assert.match(dispatchedText(), /FIRST BATCH SENTINEL/); assert.doesNotMatch(dispatchedText(), /SECOND BATCH SENTINEL/);
  });
  test('provider/model prompts require a tracked member before provider execution', () => {
    const cwd = workspace();
    const payload = '--force preserve $(literal) and "quotes"\nlast line\r\n';
    let r = run(['lmctl', 'claude/claude-fixture-1', payload], { cwd });
    assert.equal(r.status, 2); noDispatch();
    r = run(['lmctl', 'claude/claude-fixture-1', payload], { cwd, tty: true, input: 'new.lmc\nLead\n' });
    assert.notEqual(r.status, 0); // seed tripwire fails, so the requested prompt is not sent
    const text = readFileSync(join(cwd, 'new.lmc'), 'utf8');
    assert.match(text, /alias=Lead/); assert.match(text, /model=claude-fixture-1/);
    assert.doesNotMatch(text, /sessionid=/);
    assert.ok(calls()[0].argv.includes('claude-fixture-1'));
    assert.doesNotMatch(r.stderr, /Is .*the prompt/);
  });
  test('single-word intent cannot dispatch without clarification', () => {
    let r = run(['lmctl', 'claude/claude-fixture-1', 'hello']); assert.equal(r.status, 2); noDispatch();
    r = run(['lmctl', 'claude/claude-fixture-1', 'hello'], { tty: true, input: 'n\n' });
    assert.equal(r.status, 0); noDispatch();
  });
  test('confirming one-word intent still requires the missing team identity', () => {
    const r = run(['lmctl', 'claude/claude-fixture-1', 'hello'], { tty: true, input: 'yes\n' });
    assert.equal(r.status, 2); noDispatch();
  });
  test('interactive model-prefix selection uses the chosen model, not the first match', () => {
    const r = run(['lmctl', 'claude/claude-fixture', 'do this task'], { cwd: workspace(), tty: true, input: '3\nselected.lmc\nLead\n' });
    assert.notEqual(r.status, 0); assert.equal(calls().filter((c) => c.event === 'start').length, 1);
    assert.ok(calls()[0].argv.includes('claude-fixture-2'));
  });
  test('both team prompt forms leave unrelated unseeded members alone', () => {
    const cwd = workspace(); const native = nativeSession();
    const file = team(cwd, 'T.lmc', [{ alias: 'Lead', id: native.id, cwd: native.cwd }, { alias: 'Other', id: null }]);
    const before = readFileSync(file, 'utf8');
    for (const args of [[`${file}:Lead`], [file, 'Lead']]) {
      const r = run(['lmctl', ...args, 'TEAM PAYLOAD SENTINEL'], { cwd }); assert.notEqual(r.status, 0);
      assert.equal(readFileSync(file, 'utf8'), before);
    }
    assert.equal(calls().filter((c) => c.event === 'start').length, 2);
    assert.ok(dispatchedText().includes('TEAM PAYLOAD SENTINEL'));
  });
  test('raw session prompts require adoption and then dispatch through the member', () => {
    const cwd = workspace(); const native = nativeSession();
    let r = run(['lmctl', native.id, 'RAW PAYLOAD SENTINEL'], { cwd });
    assert.equal(r.status, 2); noDispatch();
    r = run(['lmctl', native.id, 'RAW PAYLOAD SENTINEL'], { cwd, tty: true, input: 'yes\nraw.lmc\nSaved\n' });
    assert.notEqual(r.status, 0); assert.ok(dispatchedText().includes('RAW PAYLOAD SENTINEL'));
    assert.equal(calls().find((c) => c.event === 'start').cwd, native.cwd);
    assert.match(readFileSync(join(cwd, 'raw.lmc'), 'utf8'), /alias=Saved/);
  });
  test('explicit prompt accepts all team target orders and rejects removed options/raw sessions', () => {
    const cwd = workspace(); const native = nativeSession();
    const file = team(cwd, 'prompt.lmc', [{ alias: 'Lead', id: native.id, cwd: native.cwd }]);
    const textFile = join(cwd, 'text.txt'); writeFileSync(textFile, 'OPAQUE $1.25 --provider TEXT\n');
    for (const target of [[file, 'Lead'], [`${file}:Lead`], [`Lead:${file}`], ['Lead', file]]) {
      const r = run(['lmctl', 'prompt', ...target, '--prompt-file', textFile], { cwd });
      assert.notEqual(r.status, 0); // provider tripwire, not parser rejection
      assert.ok(dispatchedText().includes('OPAQUE $1.25 --provider TEXT'));
    }
    const before = calls().length;
    for (const target of [['--run', '1'], ['--provider', 'claude'], ['--session', native.id], [native.id], [file, 'Lead', '--idle-timeout', '0']]) {
      assert.equal(run(['lmctl', 'prompt', ...target, 'hello'], { cwd }).status, 2);
    }
    assert.equal(calls().length, before);
  });
  test('session adoption preserves native identity/cwd and registers future raw-ID lookup', () => {
    const cwd = workspace(); const native = nativeSession(); const file = join(cwd, 'adopt.lmc');
    const r = run(['lmctl', native.id], { cwd, tty: true, input: 'yes\nadopt.lmc\nSaved\n' }); assert.equal(r.status, 0);
    const text = readFileSync(file, 'utf8'); assert.ok(text.includes(`sessionid=${native.id}`));
    assert.ok(text.includes(native.cwd)); assert.match(text, /alias=Saved/);
    const again = run(['lmctl', native.id], { cwd }); assert.equal(again.status, 0); assert.match(again.stdout, /Saved/); noDispatch();
  });
  test('adoption cannot overwrite a teamfile without the separate affirmative answer', () => {
    const cwd = workspace(); const native = nativeSession(); const file = team(cwd); const before = readFileSync(file, 'utf8');
    for (const input of ['yes\nT.lmc\nSaved\nn\n', 'yes\nT.lmc\nSaved\n']) {
      const r = run(['lmctl', native.id], { cwd, tty: true, input });
      assert.ok([0, 2].includes(r.status)); assert.equal(readFileSync(file, 'utf8'), before); noDispatch();
    }
  });
  test('old large sessions never refresh noninteractively or when declined', () => {
    const cwd = workspace(); const native = nativeSession({ ageDays: 14, context: 150000 });
    const file = team(cwd, 'old.lmc', [{ alias: 'Lead', id: native.id, cwd: native.cwd }]); const before = readFileSync(file, 'utf8');
    for (const opts of [{}, { tty: true, input: 'n\n' }, { tty: true, input: '\n' }]) {
      const r = run(['lmctl', file], { cwd, ...opts }); assert.equal(r.status, 0);
      assert.match(r.stdout, /old and large/); assert.equal(readFileSync(file, 'utf8'), before); noDispatch();
    }
  });
  test('EOF on a refresh question is not consent', () => {
    const cwd = workspace(); const native = nativeSession({ ageDays: 14, context: 150000 });
    const file = team(cwd, 'old.lmc', [{ alias: 'Lead', id: native.id, cwd: native.cwd }]); const before = readFileSync(file, 'utf8');
    const r = run(['lmctl', file], { cwd, tty: true }); assert.equal(r.status, 2);
    assert.equal(readFileSync(file, 'utf8'), before); noDispatch();
  });
  test('confirmed replacement failure preserves both binding and native transcript', () => {
    const cwd = workspace(); const native = nativeSession({ ageDays: 14, context: 150000 });
    const file = team(cwd, 'old.lmc', [{ alias: 'Lead', id: native.id, cwd: native.cwd }]);
    const before = readFileSync(file, 'utf8'); const transcript = readFileSync(native.file, 'utf8');
    const r = run(['lmctl', file], { cwd, tty: true, input: 'yes\n' }); assert.notEqual(r.status, 0);
    assert.equal(calls().filter((c) => c.event === 'start').length, 1);
    assert.equal(readFileSync(file, 'utf8'), before); assert.equal(readFileSync(native.file, 'utf8'), transcript);
  });
  test('native in-progress status suppresses refresh even without a database lease', () => {
    const cwd = workspace(); const native = nativeSession({ ageDays: 14, context: 150000, active: true });
    const file = team(cwd, 'active.lmc', [{ alias: 'Lead', id: native.id, cwd: native.cwd }]);
    const r = run(['lmctl', file], { cwd, tty: true, input: 'yes\n' }); assert.equal(r.status, 0);
    assert.match(r.stdout, /busy/); assert.doesNotMatch(r.stdout, /old and large/); noDispatch();
  });
}

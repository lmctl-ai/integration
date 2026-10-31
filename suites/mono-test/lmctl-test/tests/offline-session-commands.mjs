// Native-session fixtures for the remaining provider-free CLI command cases.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const bin = process.env.LMCTL_BIN || 'lmctl';
const root = mkdtempSync(join(tmpdir(), 'lmctl-offline-session-'));
const home = join(root, 'home');
const work = join(root, 'work');
const lmhome = join(home, '.lmctl');
const dbPath = join(root, 'state.db');
const sessionId = '11111111-2222-3333-4444-555555555555';
const env = {
  ...process.env,
  HOME: home,
  LMCTL_HOME: lmhome,
  LMCTL_DB: dbPath,
  LMCTL_PRICE_DATA: join(root, 'prices'),
  LMCTL_NON_INTERACTIVE: '1',
  LMCTL_NO_UPDATE_NOTIFIER: '1',
};
delete env.LMCTL_SELF_SESSIONID;
delete env.LMCTL_INVOCATION_ID;
mkdirSync(lmhome, { recursive: true });
mkdirSync(work, { recursive: true });
mkdirSync(env.LMCTL_PRICE_DATA, { recursive: true });
writeFileSync(join(lmhome, 'init.toml'), [1, 2, 3].map((index) =>
  '[Provider' + index + ']\nprovider = "claude"\nmodel1 = "claude-haiku-4-5"\nmodel2 = "claude-haiku-4-5"\nmodel3 = "claude-haiku-4-5"\n').join('\n'));

const project = join(home, '.claude', 'projects', 'fixture');
mkdirSync(project, { recursive: true });
// Real Claude Code transcript lines carry the role inside `message` as well as in the top-level `type`; the bounded
// session reader requires message.role, so the fixture must be shaped like a real transcript.
const nativeSession = [
  { type: 'user', cwd: work, timestamp: '2026-10-07T10:00:00Z', message: { role: 'user', content: 'fixture prompt' } },
  { type: 'assistant', cwd: work, timestamp: '2026-10-07T10:00:01Z', message: {
    role: 'assistant', id: 'fixture-message-1', model: 'claude-haiku-4-5',
    usage: { input_tokens: 12, cache_read_input_tokens: 3, cache_creation_input_tokens: 0, output_tokens: 4 },
    content: [{ type: 'text', text: 'fixture answer' }],
  } },
];
writeFileSync(join(project, sessionId + '.jsonl'), nativeSession.map(JSON.stringify).join('\n') + '\n');
writeFileSync(join(env.LMCTL_PRICE_DATA, 'model_list.json'), JSON.stringify({
  schema_version: 1,
  generated_at: '2026-10-05T00:00:00Z',
  records: [{ record_id: 'offline-haiku', source: 'litellm', source_model_id: 'claude-haiku-4-5', provider: 'anthropic', mode: 'chat',
    pricing: { input_per_1m_tokens: 1, output_per_1m_tokens: 5, input_cache_read_per_1m_tokens: 0.1 } }],
}));
writeFileSync(join(env.LMCTL_PRICE_DATA, 'aliases.json'), JSON.stringify({ schema_version: 1, standards: [], aliases: [] }));

function invoke(argv, extraEnv = {}) {
  assert.equal(argv[0], 'lmctl');
  const result = spawnSync(bin, argv.slice(1), {
    cwd: work,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('PASS ' + name);
}

try {
  check('tail --json reads the native fixture with its documented session shape', () => {
    const result = invoke(['lmctl', 'tail', '--session', sessionId, '--provider', 'claude', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.provider, 'claude');
    assert.equal(payload.sessionId, sessionId);
    assert.deepEqual(payload.messages.map((message) => [message.role, message.content]), [
      ['user', 'fixture prompt'], ['assistant', 'fixture answer'],
    ]);
    assert.equal(typeof payload.truncated, 'boolean');
  });

  check('tail reports an unknown raw session as a command failure', () => {
    const result = invoke(['lmctl', 'tail', '--session', '00000000-0000-4000-8000-000000000000', '--provider', 'claude', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not found/i);
  });

  check('export --json includes normalized messages and native session identity', () => {
    const result = invoke(['lmctl', 'export', sessionId, '--provider', 'claude', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.provider, 'claude');
    assert.equal(payload.sessionId, sessionId);
    assert.deepEqual(payload.messages.map((message) => [message.role, message.content]), [
      ['user', 'fixture prompt'], ['assistant', 'fixture answer'],
    ]);
  });

  check('export reports an unknown raw session as a command failure', () => {
    const result = invoke(['lmctl', 'export', '00000000-0000-4000-8000-000000000000', '--provider', 'claude', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not found/i);
  });

  check('cost --json reports fixture token buckets and a pinned nonzero estimate', () => {
    const result = invoke(['lmctl', 'cost', sessionId, '--provider', 'claude', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.provider, 'claude');
    assert.equal(payload.sessionId, sessionId);
    assert.deepEqual(payload.tokens, { input: 15, output: 4, cachedInput: 3 });
    assert.equal(payload.priceDataSource, 'pinned');
    assert.equal(payload.costUsd, 0.0000323);
  });

  check('cost reports an unknown raw session as a command failure', () => {
    const result = invoke(['lmctl', 'cost', '00000000-0000-4000-8000-000000000000', '--provider', 'claude', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not found/i);
  });

  check('terminal --size --json returns estimate-only session data without opening a TUI', () => {
    const missingTeam = invoke(['lmctl', 'terminal', '--team', 'coverage-team', '--size', '--json']);
    assert.notEqual(missingTeam.status, 0);
    const db = new DatabaseSync(dbPath);
    const inserted = db.prepare('INSERT INTO team(name, created_at) VALUES (?, ?)').run('coverage-team', new Date().toISOString());
    db.prepare('INSERT INTO team_member(team_id, alias, role, provider, model, sessionid, sessiondir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Number(inserted.lastInsertRowid), 'Lead', 'agent', 'claude', 'claude-haiku-4-5', sessionId, work, new Date().toISOString());
    db.close();
    const result = invoke(['lmctl', 'terminal', '--team', 'coverage-team', '--alias', 'Lead', '--size', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.estimate, true);
    assert.equal(payload.guide_tokens, 200000);
    assert.equal(payload.members.length, 1);
    assert.deepEqual(payload.members[0], {
      alias: 'Lead', provider: 'claude', sessionid: sessionId, messages: 2, bytes: null,
      est_tokens: 7, estimate: true, over_guide: false, model: 'claude-haiku-4-5', resume_incantation: null,
    });
  });

  check('terminal size reports an unknown member without launching a TUI', () => {
    const result = invoke(['lmctl', 'terminal', '--team', 'coverage-team', '--alias', 'Missing', '--size', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /member not found/i);
  });

  check('terminal non-interactive refusal exits nonzero with its message without launching a TUI', () => {
    const teamfile = join(work, 'terminal-refusal.lmctl');
    writeFileSync(teamfile, `_TEAM_ name=coverage-team\n_MEMBER_ alias=Lead provider=claude model=claude-haiku-4-5 sessionid=${sessionId}\n`);
    const result = invoke(['lmctl', 'terminal', teamfile, 'Lead']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /terminal opens an interactive TUI; non-interactive mode is enabled/i);
  });
  console.log(passed + ' assertions: ' + passed + ' pass, 0 fail');
} finally {
  rmSync(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'lmctl-miniplayer-mock-'));
const home = join(root, 'home');
const dataHome = join(root, 'data');
const lmctlHome = join(home, '.lmctl');
const miniplayerHome = join(root, 'miniplayer');
const sessionDir = join(root, 'workspace');
const db = join(root, 'lmctl.db');
const untouchedDb = join(lmctlHome, 'state.db');
const overrideDb = join(root, 'override.db');
const shimDir = join(root, 'bin');
const lmctlBin = process.env.LMCTL_BIN || 'lmctl';
const requestedMiniplayerBin = process.env.MINIPLAYER_BIN || 'miniplayer';
function resolveCommand(command, pathValue = process.env.PATH || '') {
  if (command.includes('/')) return existsSync(resolve(command)) ? resolve(command) : command;
  for (const directory of pathValue.split(':')) {
    const candidate = join(directory || '.', command);
    if (existsSync(candidate)) return resolve(candidate);
  }
  return command;
}
const miniplayerBin = resolveCommand(requestedMiniplayerBin);
mkdirSync(shimDir, { recursive: true });
const miniplayerShim = join(shimDir, 'miniplayer');
writeFileSync(miniplayerShim, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const target = process.env.MINIPLAYER_TARGET;
const args = process.env.MINIPLAYER_TARGET_JS === '1' ? [target, ...process.argv.slice(2)] : process.argv.slice(2);
const child = spawn(process.env.MINIPLAYER_TARGET_JS === '1' ? process.execPath : target, args, { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { process.stderr.write(error.message + '\\n'); process.exit(1); });
child.on('close', code => process.exit(code ?? 1));
`);
chmodSync(miniplayerShim, 0o755);
const baseEnv = { ...process.env, HOME: home, XDG_DATA_HOME: dataHome, LMCTL_HOME: lmctlHome, MINIPLAYER_HOME: miniplayerHome, LMCTL_DB: db, MINIPLAYER_TARGET: miniplayerBin, MINIPLAYER_TARGET_JS: miniplayerBin.endsWith('.js') ? '1' : '0', PATH: `${shimDir}:${process.env.PATH || ''}` };
const timeoutMs = 15000;

function command(bin, args, env = baseEnv) {
  const executable = bin.endsWith('.js') ? process.execPath : bin;
  const executableArgs = bin.endsWith('.js') ? [bin, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, executableArgs, { cwd: sessionDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    let hardTimer;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      hardTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    }, timeoutMs);
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(hardTimer); reject(error); } });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(hardTimer);
      if (timedOut) reject(new Error(`${basename(bin)} timed out`));
      else resolve({ code, signal, stdout, stderr });
    });
  });
}

function acpProcess(model) {
  const executable = miniplayerBin.endsWith('.js') ? process.execPath : miniplayerBin;
  const args = miniplayerBin.endsWith('.js') ? [miniplayerBin, 'acp', '--model', model] : ['acp', '--model', model];
  const child = spawn(executable, args, { cwd: sessionDir, env: baseEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false;
  let closeResolve;
  const closePromise = new Promise(resolveClose => { closeResolve = resolveClose; });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = new Map();
  const notifications = [];
  let shuttingDown = false;
  let fatalError;
  function fail(error) {
    if (fatalError) return;
    fatalError = error;
    for (const [id, pending] of replies) { clearTimeout(pending.timer); pending.reject(error); replies.delete(id); }
  }
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch (error) { fail(new Error(`invalid ACP JSON line: ${line}`)); return; }
    if (!message || message.jsonrpc !== '2.0' || (message.id === undefined && !message.method)) { fail(new Error(`invalid ACP envelope: ${line}`)); return; }
    if (message.id !== undefined) {
      if (!replies.has(message.id)) { fail(new Error(`unexpected ACP response ID: ${message.id}`)); return; }
      const pending = replies.get(message.id); replies.delete(message.id); clearTimeout(pending.timer); pending.resolve(message);
    } else notifications.push(message);
  });
  child.once('error', fail);
  child.once('close', (code, signal) => {
    closed = true; closeResolve();
    if (!shuttingDown) fail(new Error(`ACP child exited (${code ?? 'null'}${signal ? `/${signal}` : ''})`));
  });
  child.stderr.resume();
  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      if (fatalError) { reject(fatalError); return; }
      const timer = setTimeout(() => { replies.delete(id); reject(new Error(`ACP request ${method} timed out`)); }, timeoutMs);
      replies.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async function close() {
    shuttingDown = true; lines.close(); child.stdin.end();
    if (!closed) child.kill('SIGTERM');
    await Promise.race([closePromise, new Promise(resolveAfter => setTimeout(resolveAfter, 1000))]);
    if (!closed) child.kill('SIGKILL');
    await Promise.race([closePromise, new Promise(resolveAfter => setTimeout(resolveAfter, 1000))]);
  }
  return { request, notifications, close };
}

function sessionRecords() {
  const directory = join(miniplayerHome, 'sessions');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
}

async function main() {
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(lmctlHome, { recursive: true });
  writeFileSync(untouchedDb, 'do-not-touch\n');
  await assert.rejects(command(join(root, 'missing-miniplayer'), ['--help']), /ENOENT/);
  const acp = acpProcess('mock/Adder');
  try {
    const initialized = await acp.request('initialize', { protocolVersion: 1 });
    assert.equal(initialized.id, 1); assert.equal(initialized.result.protocolVersion, 1);
    assert.equal(initialized.result.agentInfo.name, 'miniplayer');
    const unknown = await acp.request('unknownmethod', {});
    assert.equal(unknown.id, 2); assert.equal(unknown.error.code, -32601);
    const first = await acp.request('session/new', { cwd: sessionDir, mcpServers: [] });
    assert.match(first.result.sessionId, /^[a-f0-9-]{36}$/);
    const sessionId = first.result.sessionId;
    const invalid = await acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'not-a-number' }] });
    assert.equal(invalid.error.code, -32000); assert.match(invalid.error.message, /finite .*number/);
    const two = await acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '2' }] });
    assert.equal(two.result.stopReason, 'end_turn');
    const five = await acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '3' }] });
    assert.equal(five.result.stopReason, 'end_turn');
    const resume = await acp.request('session/load', { sessionId });
    assert.equal(resume.error.code, -32602); assert.match(resume.error.message, /does not support session resume/);
    const second = await acp.request('session/new', { cwd: sessionDir, mcpServers: [] });
    const isolated = await acp.request('session/prompt', { sessionId: second.result.sessionId, prompt: [{ type: 'text', text: '4' }] });
    assert.equal(isolated.result.stopReason, 'end_turn');
    const updates = acp.notifications.filter(message => message.method === 'session/update');
    assert.deepEqual(updates.map(message => message.params.update.content.text), ['2', '5', '4']);
    assert.deepEqual(new Set(updates.map(message => message.params.sessionId)), new Set([sessionId, second.result.sessionId]));
  } finally { await acp.close(); }

  const records = sessionRecords();
  assert.equal(records.length, 2, 'two ACP sessions should be persisted');
  const accumulated = records.find(record => record.turns.length === 3);
  assert.ok(accumulated, 'invalid and two valid Adder prompts should remain in one record');
  assert.deepEqual(accumulated.turns.map(turn => turn.status), ['failed', 'complete', 'complete']);
  assert.deepEqual(accumulated.turns.map(turn => turn.output?.text ?? null), [null, '2', '5']);
  assert.equal(accumulated.model, 'Adder');
  assert.ok(accumulated.turns.filter(turn => turn.status === 'complete')
    .every(turn => turn.usage && turn.usage.inputTokens === 0 && turn.usage.outputTokens === 0));

  const fresh = acpProcess('mock/Adder');
  try {
    await fresh.request('initialize', { protocolVersion: 1 });
    const cannotLoad = await fresh.request('session/load', { sessionId: accumulated.id });
    assert.equal(cannotLoad.error.code, -32602);
    const newSession = await fresh.request('session/new', { cwd: sessionDir, mcpServers: [] });
    const reset = await fresh.request('session/prompt', { sessionId: newSession.result.sessionId, prompt: [{ type: 'text', text: '1' }] });
    assert.equal(reset.result.stopReason, 'end_turn');
    const freshUpdates = fresh.notifications.filter(message => message.method === 'session/update');
    assert.deepEqual(freshUpdates.map(message => [message.params.sessionId, message.params.update.content.text]), [[newSession.result.sessionId, '1']]);
  } finally { await fresh.close(); }

  for (const [model, status, text] of [['RateLimit', 429, 'mock rate limit exceeded'], ['ServerError', 503, 'mock temporary server error']]) {
    const failing = acpProcess(`mock/${model}`);
    try {
      await failing.request('initialize', { protocolVersion: 1 });
      const created = await failing.request('session/new', { cwd: sessionDir, mcpServers: [] });
      const response = await failing.request('session/prompt', { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'probe' }] });
      assert.equal(response.error.data.status, status);
      assert.equal(response.error.data.message, text);
    } finally { await failing.close(); }
  }

  const echo = await command(lmctlBin, ['prompt', '--provider', 'miniplayer', '--model', 'mock/Echo', '--sessiondir', sessionDir, '--json', 'echo this exactly']);
  assert.equal(echo.code, 0, echo.stderr);
  const echoPayload = JSON.parse(echo.stdout);
  assert.equal(echoPayload.replyText, 'echo this exactly');
  for (const model of ['RateLimit', 'ServerError']) {
    const result = await command(lmctlBin, ['prompt', '--provider', 'miniplayer', '--model', `mock/${model}`, '--sessiondir', sessionDir, '--json', 'failure probe']);
    assert.notEqual(result.code, 0, `${model} should fail`);
    assert.match(`${result.stdout}\n${result.stderr}`, model === 'RateLimit' ? /mock rate limit exceeded|429|rate.limit/i : /mock temporary server error|503|server.error/i);
  }
  const dbProbe = await command(lmctlBin, ['ls', '--runs', '--json']);
  assert.equal(dbProbe.code, 0, dbProbe.stderr);
  assert.equal(readFileSync(untouchedDb, 'utf8'), 'do-not-touch\n');
  assert.ok(existsSync(db), 'LMCTL_DB override should be created');
  assert.equal(readFileSync(db, { encoding: 'utf8', flag: 'r' }).slice(0, 6), 'SQLite');
  const cliDb = await command(lmctlBin, ['--db', overrideDb, 'ls', '--runs', '--json']);
  assert.equal(cliDb.code, 0, cliDb.stderr);
  assert.ok(existsSync(overrideDb), '--db should override LMCTL_DB');
  assert.equal(readFileSync(untouchedDb, 'utf8'), 'do-not-touch\n');
  assert.equal(existsSync(`${untouchedDb}-wal`), false);
  assert.equal(existsSync(`${untouchedDb}-journal`), false);
  console.log('PASS miniplayer mock ACP and lmctl integration (Echo, RateLimit, ServerError, Adder)');
}

try { await main(); }
catch (error) { console.error(`FAIL miniplayer mock integration: ${error.stack || error}`); process.exitCode = 1; }
finally { rmSync(root, { recursive: true, force: true }); }

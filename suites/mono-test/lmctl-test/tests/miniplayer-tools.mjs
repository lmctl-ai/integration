import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const lmctlBin = process.env.LMCTL_BIN ? resolve(process.env.LMCTL_BIN) : undefined;
const requestedMiniplayerBin = process.env.MINIPLAYER_BIN;
if (!lmctlBin || !existsSync(resolve(lmctlBin))) throw new Error('missing dependency: set LMCTL_BIN to the lmctl executable');
if (!requestedMiniplayerBin || !existsSync(resolve(requestedMiniplayerBin))) throw new Error('missing dependency: set MINIPLAYER_BIN to miniplayer/bin/miniplayer.js');
const miniplayerBin = resolve(requestedMiniplayerBin);
const root = mkdtempSync(join(tmpdir(), 'lmctl-miniplayer-tools-'));
const home = join(root, 'home');
const dataHome = join(root, 'data');
const lmctlHome = join(home, '.lmctl');
const miniplayerHome = join(root, 'miniplayer');
const sessionDir = join(root, 'workspace');
const db = join(root, 'lmctl.db');
const untouchedDb = join(lmctlHome, 'state.db');
const shimDir = join(root, 'bin');
const config = join(root, 'config.json');
const catalog = join(root, 'catalog.json');
const timeoutMs = 30000;
mkdirSync(shimDir, { recursive: true }); mkdirSync(sessionDir, { recursive: true }); mkdirSync(lmctlHome, { recursive: true });
writeFileSync(untouchedDb, 'do-not-touch\n'); writeFileSync(config, '{}'); writeFileSync(catalog, JSON.stringify({ schema_version: 1, records: [] }));
const shim = join(shimDir, 'miniplayer');
writeFileSync(shim, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(miniplayerBin)}, ...process.argv.slice(2)], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { process.stderr.write(error.message + '\\n'); process.exit(1); });
child.on('close', code => process.exit(code ?? 1));
`); chmodSync(shim, 0o755);

const fileContent = '0123456789'.repeat(7000);
const requests = [];
let baseUrl = '';
const tools = [
  ['write_file', { path: 'made.txt', content: fileContent }],
  ['read_file', { path: 'made.txt', offset: 3, maxBytes: 65536 }],
  ['list_directory', { path: '.', limit: 20 }],
  ['shell', { command: 'printf shell-out; printf shell-err >&2' }],
  ['webget', { url: '', offset: 3, maxBytes: 5 }],
];

const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  if (request.url === '/page') { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('0123456789abcdef'); return; }
  if (!body) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ models: [] })); return; }
  const payload = JSON.parse(body); requests.push(payload);
  const step = requests.length - 1;
  const selected = tools[step];
  response.writeHead(200, { 'content-type': 'application/json' });
  if (selected) {
    const args = { ...selected[1] };
    if (selected[0] === 'webget') args.url = `${baseUrl}/page`;
    response.end(JSON.stringify({ id: `response-${step}`, object: 'chat.completion', created: 1, model: 'fixture',
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: `call-${step}`, type: 'function', function: { name: selected[0], arguments: JSON.stringify(args) } }] } }],
      usage: { prompt_tokens: 10 + step, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 2, total_tokens: 12 + step } }));
  } else response.end(JSON.stringify({ id: `response-${step}`, object: 'chat.completion', created: 1, model: 'fixture',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'TOOLS_OK' } }],
    usage: { prompt_tokens: 15, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 2, total_tokens: 17 } }));
});

function run(bin, args, env) {
  const executable = bin.endsWith('.js') ? process.execPath : bin;
  const executableArgs = bin.endsWith('.js') ? [bin, ...args] : args;
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, executableArgs, { cwd: sessionDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false; let hardTimer;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); hardTimer = setTimeout(() => child.kill('SIGKILL'), 1000); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); clearTimeout(hardTimer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); clearTimeout(hardTimer); resolveResult({ code, signal, stdout, stderr, timedOut }); });
  });
}

async function main() {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: dataHome, LMCTL_HOME: lmctlHome, LMCTL_DB: db,
    MINIPLAYER_HOME: miniplayerHome, MINIPLAYER_CONFIG: config, MINIPLAYER_LMPRICE_CATALOG: catalog,
    OLLAMA_HOST: baseUrl, PATH: `${shimDir}:${process.env.PATH || ''}` };
  const prompt = await run(lmctlBin, ['prompt', '--provider', 'miniplayer', '--model', 'ollama/fixture', '--sessiondir', sessionDir, '--json', 'Exercise all five tools'], env);
  assert.equal(prompt.timedOut, false); assert.equal(prompt.code, 0, `${prompt.stderr}\n${prompt.stdout}`);
  const reply = JSON.parse(prompt.stdout); assert.equal(reply.replyText, 'TOOLS_OK');
  const sessions = readdirSync(join(miniplayerHome, 'sessions')).filter(name => name.endsWith('.json'));
  assert.equal(sessions.length, 1); const sessionId = basename(sessions[0], '.json');
  assert.equal(readFileSync(join(sessionDir, 'made.txt'), 'utf8'), fileContent);
  assert.equal(requests.length, 6);
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name).sort(), tools.map(tool => tool[0]).sort());
  const results = requests.at(-1).messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(results.length, 5);
  assert.equal(results[0].bytesWritten, fileContent.length);
  assert.equal(results[1].bytesRead, 65536); assert.equal(results[1].nextOffset, 65539); assert.equal(results[1].content, fileContent.slice(3, 65539));
  assert.ok(results[2].entries.some(entry => entry.name === 'made.txt'));
  assert.deepEqual(results[3], { exitCode: 0, signal: null, stdout: 'shell-out', stderr: 'shell-err', truncated: false });
  assert.deepEqual(results[4], { status: 200, contentType: 'text/plain', finalUrl: `${baseUrl}/page`, content: '34567', bytesRead: 5, nextOffset: 8, eof: false, truncated: true });
  const exported = await run(lmctlBin, ['export', sessionId, '--provider', 'miniplayer', '--json'], env);
  assert.equal(exported.timedOut, false);
  assert.equal(exported.code, 0, `${exported.stderr}\n${exported.stdout}`);
  const detail = JSON.parse(exported.stdout);
  assert.equal(detail.replyText, undefined); assert.equal(detail.responses.length, 6); assert.equal(detail.totalOutputTokens, 12);
  assert.equal(detail.responses[0].files_written[0].bytes, fileContent.length);
  assert.equal(detail.responses[1].files_read[0].bytes, 65536);
  assert.equal(detail.responses.find(response => response.response_id === detail.turns[0].responseIds[3]).files_read, null);
  assert.equal(detail.responses.find(response => response.response_id === detail.turns[0].responseIds[3]).read_bytes, null);
  assert.equal(readFileSync(untouchedDb, 'utf8'), 'do-not-touch\n');
  assert.equal(existsSync(untouchedDb + '-wal'), false); assert.equal(existsSync(untouchedDb + '-journal'), false);
  console.log('PASS miniplayer real CLI tools integration (all five tools, export, accounting, isolated DB)');
}

try { await main(); }
catch (error) { console.error(`FAIL miniplayer tools integration: ${error.stack || error}`); process.exitCode = 1; }
finally { server.closeAllConnections(); await new Promise(resolveClose => server.close(() => resolveClose())); rmSync(root, { recursive: true, force: true }); }

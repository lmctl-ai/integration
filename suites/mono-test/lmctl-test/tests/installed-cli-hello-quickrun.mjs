// Installed-package smoke coverage. This never imports lmctl-src or uses a checkout binary.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const bin = process.env.LMCTL_BIN || 'lmctl';
const lmscript = process.env.LMSCRIPT_BIN || 'lmscript';
const root = mkdtempSync(join(tmpdir(), 'lmctl-installed-cli-'));
const home = join(root, 'home');
const work = join(root, 'work');
const env = { ...process.env, HOME: home, LMCTL_HOME: join(home, '.lmctl'), LMCTL_DB: join(root, 'lmctl.db'), LMCTL_NON_INTERACTIVE: '1' };
delete env.LMCTL_SELF_SESSIONID;
delete env.LMCTL_LAUNCH_SOURCE;
delete env.CODEX_HOME;
mkdirSync(join(home, '.lmctl'), { recursive: true });
mkdirSync(work, { recursive: true });
writeFileSync(join(home, '.lmctl', 'init.toml'), [1, 2, 3].map((i) =>
  `[Provider${i}]\nprovider = "claude"\nmodel1 = "smoke"\nmodel2 = "smoke"\nmodel3 = "smoke"\n`).join('\n'));

function run(args, options = {}) {
  assert.equal(args[0], 'lmctl');
  return execFileSync(bin, args.slice(1), { cwd: work, env, encoding: 'utf8', timeout: 120000, ...options });
}

function runResult(args, options = {}) {
  assert.equal(args[0], 'lmctl');
  const result = spawnSync(bin, args.slice(1), { cwd: work, env, encoding: 'utf8', timeout: 120000, ...options });
  if (result.error) throw result.error;
  return result;
}

const authRelativePath = { codex: '.codex/auth.json', agy: '.gemini/antigravity-cli/antigravity-oauth-token' };
let liveRoot;
let liveChild;
let handlingSignal = false;
let assertions = 3;
function cleanup() {
  if (liveRoot) rmSync(liveRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
function onSignal(signal) {
  if (handlingSignal) return;
  handlingSignal = true;
  if (liveChild?.pid) {
    try { process.kill(-liveChild.pid, signal); } catch { liveChild.kill(signal); }
  }
  cleanup();
  process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
}
process.once('SIGINT', () => onSignal('SIGINT'));
process.once('SIGTERM', () => onSignal('SIGTERM'));

function credentialSource(provider) {
  const relative = authRelativePath[provider];
  if (!relative) throw new Error(`Unsupported live hello provider: ${provider}`);
  return join(process.env.LMCTL_HELLO_CREDENTIAL_HOME || homedir(), relative);
}

function redact(text) {
  return text
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;}]+/gi, '$1[REDACTED]');
}

function runLive(args, liveEnv) {
  return new Promise((resolve, reject) => {
    liveChild = spawn(bin, args, { cwd: work, env: liveEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    liveChild.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    liveChild.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
    liveChild.once('error', reject);
    liveChild.once('close', (code, signal) => {
      liveChild = undefined;
      if (code === 0) resolve(stdout);
      else reject(new Error(`lmctl hello exited ${code ?? signal}\nstdout:\n${redact(stdout)}\nstderr:\n${redact(stderr)}`));
    });
  });
}

try {
  const script = join(work, 'argv-check.lms');
  writeFileSync(script, 'println(args[0]); println(args[1]);');
  const output = run(['lmctl', 'quickrun', script, '--json', 'value with spaces']);
  assert.equal(output, '--json\nvalue with spaces\n', 'quickrun must preserve option-looking and spaced script arguments');
  console.log('PASS installed quickrun local script argument forwarding');
  const missingSample = runResult(['lmctl', 'quickrun', './missing-offline-sample.lms']);
  assert.notEqual(missingSample.status, 0, 'quickrun must fail for a missing local script');
  assert.match(String(missingSample.stderr ?? ''), /could not fetch|ENOENT/i);
  assertions += 1;
  console.log('PASS quickrun reports a missing local script without fetching a sample');

  const lmscriptOutput = execFileSync(lmscript, ['-e', 'print(args[0]); print(args[1]); require(ARGV[0] == args[0] && ARGV[1] == args[1], "ARGV tail mismatch");', '--', 'value with spaces'], {
    cwd: work, env, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(lmscriptOutput, '--\nvalue with spaces\n', 'the source tail, including --, is ordinary data in args and ARGV');
  console.log('PASS packaged lmscript subprocess argument forwarding');

  const help = run(['lmctl', 'hello', '--help']);
  assert.match(help, /usage: lmctl hello/);
  console.log('PASS installed hello entry point');

  const provider = process.env.LMCTL_LIVE_HELLO_PROVIDER;
  if (provider) {
    const source = credentialSource(provider);
    if (!existsSync(source)) {
      console.log(`NOTE live hello skipped for ${provider}: missing credential file ${authRelativePath[provider]}.`);
    } else {
      liveRoot = mkdtempSync(join(tmpdir(), 'lmctl-installed-cli-live-'));
      const liveHome = join(liveRoot, 'home');
      const relative = authRelativePath[provider];
      const copiedCredential = join(liveHome, relative);
      mkdirSync(dirname(copiedCredential), { recursive: true, mode: 0o700 });
      copyFileSync(source, copiedCredential);
      chmodSync(copiedCredential, 0o600);
      assert.equal(statSync(copiedCredential).mode & 0o777, 0o600, 'copied credential must be owner-readable only');
      // LMCTL_HELLO_LIVE_ROOT_MARKER is a scratch-only control for cleanup tests; it records no secret data.
      if (process.env.LMCTL_HELLO_LIVE_ROOT_MARKER) writeFileSync(process.env.LMCTL_HELLO_LIVE_ROOT_MARKER, liveRoot);
      const liveEnv = {
        ...env,
        HOME: liveHome,
        LMCTL_HOME: join(liveHome, '.lmctl'),
        LMCTL_DB: join(liveRoot, 'lmctl.db'),
      };
      mkdirSync(liveEnv.LMCTL_HOME, { recursive: true });
      writeFileSync(join(liveEnv.LMCTL_HOME, 'init.toml'), readFileSync(join(home, '.lmctl', 'init.toml')));
      delete liveEnv.LMCTL_SELF_SESSIONID;
      delete liveEnv.LMCTL_LAUNCH_SOURCE;
      delete liveEnv.CODEX_HOME;
      delete liveEnv.OPENAI_API_KEY;
      delete liveEnv.CODEX_API_KEY;
      delete liveEnv.GEMINI_API_KEY;
      delete liveEnv.GOOGLE_API_KEY;
      const prompt = 'Reply with the exact token LMCTL_HELLO_OK and no other required content.';
      try {
        const live = await runLive(['hello', provider, '--prompt', prompt], liveEnv);
        assert.match(live, /LMCTL_HELLO_OK/, 'live hello response must contain the requested sentinel');
        const teamfile = join(work, `${provider}_hello.lmctl`);
        assert.match(readFileSync(teamfile, 'utf8'), /_MEMBER_/, 'hello must leave the seeded teamfile');
        assertions += 2;
        console.log(`PASS live installed hello for ${provider}`);
      } finally {
        rmSync(liveRoot, { recursive: true, force: true });
        liveRoot = undefined;
      }
    }
  } else {
    console.log('NOTE live hello skipped; set LMCTL_LIVE_HELLO_PROVIDER to use provider credentials.');
  }
  console.log(`${assertions} assertions: ${assertions} pass, 0 fail`);
} finally {
  cleanup();
}

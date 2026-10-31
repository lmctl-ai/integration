// Plain script runs, the no-API host installer and `lmctl script` modes, against the INSTALLED lmctl (LMCTL_BIN).
//
// A. Plain run: `lmctl FILE.lms` and `lmctl http://127.0.0.1:P/FILE.lms` (a loopback server) run the script as written,
//    forward arguments, and a missing provider is an error that names the provider, with no substitution offered.
//    `lmctl autorun URL` still adapts a declared role to an installed provider (a fake codex). The local-file autorun
//    cases live in offline-commands.mjs and are not repeated here.
// B. No-API install through `lmctl script`: a loopback server emulates github.com (releases/latest redirect,
//    releases/download assets behind an objects redirect, SHA256SUMS) and a second loopback server stands in for
//    api.github.com, both reached through lmscript's test seams LMSCRIPT_GITHUB_HTTP and LMSCRIPT_GITHUB_API, with a
//    private LMSCRIPT_TOOL_CACHE. Pinned and @latest installs make zero API requests; a cache hit makes no request at all;
//    a SHA-256 mismatch is refused and caches nothing; a release with no checksum anywhere warns exactly once (after the
//    documented last resort, one API digest lookup); a rate-limited (403) newest-release check falls back to the cached
//    binary with one warning, and fails with a cold cache.
// C. `lmctl script --check / --lint / --dry-run / --version` smoke, and check/lint of an @latest `load_schema(cli= install=)` program
//    script never touch the network.
//
// Hermetic: HOME, LMCTL_DB and the tool cache are private; PATH holds only node and /usr/bin:/bin (no provider CLI);
// a NODE_OPTIONS preload refuses any non-loopback DNS lookup or fetch in lmctl and every node child it starts, and its
// log must stay empty. Every assertion carries mutation controls applied to the real captured result.
// Output: PASS/SKIP/FAIL lines and "N assertions: P pass[, S skipped], F fail".

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'lmctl-run-install-'));
const rawBin = process.env.LMCTL_BIN || 'lmctl';
let bin = rawBin;
if (!rawBin.includes('/')) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (existsSync(join(dir, rawBin))) { bin = join(dir, rawBin); break; }
  }
}

// Only node on PATH: the host's real provider CLIs (kimi, codex, claude, agy ...) must be invisible.
const pbin = join(root, 'pbin');
mkdirSync(pbin);
symlinkSync(realpathSync(process.execPath), join(pbin, 'node'));
const guardLog = join(root, 'loopback-guard.log');
const guard = join(root, 'loopback-guard.mjs');
writeFileSync(guard, `import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(guardLog)};
const ok = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
const refuse = (what) => { appendFileSync(log, process.pid + ' ' + what + '\\n'); const e = new Error('loopback guard refused ' + what); e.code = 'ENOTFOUND'; return e; };
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) { if (!ok(host)) { const cb = rest.at(-1); const e = refuse('dns ' + host); if (typeof cb === 'function') return process.nextTick(cb, e); throw e; } return lookup.call(this, host, ...rest); };
const plookup = dns.promises.lookup;
dns.promises.lookup = async (host, ...rest) => { if (!ok(host)) throw refuse('dns ' + host); return plookup(host, ...rest); };
const f = globalThis.fetch;
if (f) globalThis.fetch = (input, init) => { const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); return ok(u.hostname) ? f(input, init) : Promise.reject(refuse('fetch ' + u.origin)); };
`);
const home = join(root, 'home');
mkdirSync(home);
const baseEnv = {
  PATH: `${pbin}:/usr/bin:/bin`,
  HOME: home,
  LMCTL_DB: join(root, 'state.db'),
  LMCTL_NO_UPDATE_NOTIFIER: '1',
  NODE_OPTIONS: `--import ${guard}`,
  ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
};

let passed = 0;
let failed = 0;
let skipped = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${String(error?.message ?? error).split('\n').slice(0, 8).join(' | ')}`);
  }
}
function skip(name, reason) {
  skipped += 1;
  console.log(`SKIP ${name}: ${reason}`);
}
// The assertion must accept the real result and reject every mutant derived from it.
function controls(assertFn, result, mutants) {
  assertFn(result);
  for (const [label, mutate] of mutants) {
    assert.throws(() => assertFn(mutate(structuredClone(result))), undefined, `mutation control not rejected: ${label}`);
  }
}
const set = (key, value) => (x) => ({ ...x, [key]: value });
const edit = (key, from, to) => (x) => ({ ...x, [key]: String(x[key]).replace(from, to) });

// Children run asynchronously so the in-process loopback servers keep answering.
function lmctl(argv, { cwd = root, env = {}, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd, env: { ...baseEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

try {
  const help = (await lmctl(['--help'])).stdout;
  const version = (await lmctl(['--version'])).stdout.trim().replace(/^lmctl\s+/, '');

  // ---- A. plain run --------------------------------------------------------------------------------------------
  const web = join(root, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'hello.lms'), 'println("SCRIPT-AS-WRITTEN");\nprintln("ARG0:" + args[0]);\nprintln("ARG1:" + args[1]);\n');
  writeFileSync(join(web, 'Missing.lmctl'), '_MEMBER_ alias=Lead provider=kimi model=Kimi-K2.5 sessiondir=.\n');
  writeFileSync(join(web, 'missing-provider.lms'), 'result = lm_seed("Missing.lmctl");\nrequire(result.status == "ok", result.error);\nprintln("UNREACHED-AFTER-SEED");\n');
  writeFileSync(join(web, 'role.lms'), '// autorun-role: Lead provider=kimi model=Kimi-K2.5\nprintln("ROLE:" + "@role(Lead.provider)" + "/" + "@role(Lead.model)");\n');
  const webRequests = [];
  const site = await listen((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    webRequests.push(`${req.method} ${path}`);
    const file = join(web, path.replace(/^\/+/, ''));
    if (!path.includes('..') && existsSync(file) && file.endsWith('.lms')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(readFileSync(file)); return; }
    res.writeHead(404); res.end('not found');
  });
  const missingMessage = /provider "kimi" binary 'kimi' not installed/;
  const noAdaptation = (r) => { assert.doesNotMatch(r.stdout + r.stderr, /Suggested provider\/model substitutions|accept\/edit\/save|Saved mapped script/); };

  if (!/lmctl script\.lms \[args\.\.\.\]/.test(help)) {
    skip('A plain run', 'NOT-IN-RELEASE: lmctl --help does not document the FILE.lms partial-input form');
  } else {
    await check('A1 lmctl FILE.lms runs a local script as written and forwards arguments verbatim', async () => {
      const r = await lmctl(['hello.lms', '--json', 'value with spaces'], { cwd: web });
      const a = (x) => { assert.equal(x.status, 0, x.stderr); assert.equal(x.stdout, 'SCRIPT-AS-WRITTEN\nARG0:--json\nARG1:value with spaces\n'); assert.doesNotMatch(x.stderr, /^Running /m); };
      controls(a, r, [['exit 1', set('status', 1)], ['spaces lost', edit('stdout', 'value with spaces', 'value')], ['flag eaten', edit('stdout', 'ARG0:--json', 'ARG0:value with spaces')], ['announced as autorun', set('stderr', 'Running hello.lms\n')]]);
    });
    await check('A2 lmctl http://127.0.0.1/FILE.lms fetches once, says to run only trusted scripts, runs as written', async () => {
      const from = webRequests.length;
      const r = await lmctl([`${site.url}/hello.lms`, 'a', 'b c'], { cwd: web });
      const x = { ...r, requests: webRequests.slice(from) };
      const a = (y) => {
        assert.equal(y.status, 0, y.stderr);
        assert.equal(y.stdout, 'SCRIPT-AS-WRITTEN\nARG0:a\nARG1:b c\n');
        assert.match(y.stderr, new RegExp(`^Running ${esc(site.url)}/hello\\.lms \\(only run scripts you trust\\)$`, 'm'));
        assert.deepEqual(y.requests, ['GET /hello.lms']);
        noAdaptation(y);
      };
      controls(a, x, [['exit 1', set('status', 1)], ['no trust notice', set('stderr', '')], ['fetched twice', (y) => ({ ...y, requests: [...y.requests, 'GET /hello.lms'] })], ['argument lost', edit('stdout', 'ARG1:b c', 'ARG1:')]]);
    });
    await check('A3 a URL that answers 404 is an error naming the status and the URL (exit 2), nothing runs', async () => {
      const r = await lmctl([`${site.url}/absent.lms`], { cwd: web });
      const a = (y) => { assert.equal(y.status, 2); assert.match(y.stderr, new RegExp(`^error: HTTP 404 fetching ${esc(site.url)}/absent\\.lms$`, 'm')); assert.equal(y.stdout, ''); };
      controls(a, r, [['exit 0', set('status', 0)], ['other status', edit('stderr', 'HTTP 404', 'HTTP 500')], ['something ran', set('stdout', 'SCRIPT-AS-WRITTEN\n')]]);
    });
    for (const [label, target] of [['local file', () => 'missing-provider.lms'], ['loopback URL', () => `${site.url}/missing-provider.lms`]]) {
      await check(`A4 missing provider (${label}): exit 1, prints the not-installed message, no substitution, nothing after the seed`, async () => {
        const r = await lmctl([target()], { cwd: web });
        const a = (y) => {
          assert.equal(y.status, 1);
          assert.match(y.stderr, missingMessage);
          assert.match(y.stderr, /=== LMScript Error Summary \(1 error\) ===/);
          assert.doesNotMatch(y.stdout, /UNREACHED-AFTER-SEED/);
          noAdaptation(y);
        };
        controls(a, r, [['exit 0', set('status', 0)], ['message gone', edit('stderr', new RegExp(missingMessage.source, 'g'), 'seed failed')], ['adapted instead', edit('stdout', /^/, 'Suggested provider/model substitutions:\n')], ['kept running', edit('stdout', /^/, 'UNREACHED-AFTER-SEED\n')]]);
      });
    }
    await check('A5 a declared role is left as written by a plain URL run (no @role rewriting)', async () => {
      const r = await lmctl([`${site.url}/role.lms`], { cwd: web });
      const a = (y) => { assert.equal(y.status, 0, y.stderr); assert.equal(y.stdout, 'ROLE:@role(Lead.provider)/@role(Lead.model)\n'); noAdaptation(y); };
      controls(a, r, [['rewritten', edit('stdout', '@role(Lead.provider)/@role(Lead.model)', 'codex/gpt-6-luna')], ['exit 1', set('status', 1)]]);
    });
  }

  if (!/^  autorun /m.test(help)) {
    skip('A autorun URL adaptation', 'NOT-IN-RELEASE: no autorun command');
  } else {
    // A fake codex (the offline suite's fixture) is the only installed provider, so kimi maps to codex/gpt-6-luna.
    const withCodex = join(root, 'pbin-codex');
    mkdirSync(withCodex);
    symlinkSync(realpathSync(process.execPath), join(withCodex, 'node'));
    writeFileSync(join(withCodex, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi\nif [ "$1" = "debug" ] && [ "$2" = "models" ]; then echo \'{"models":[{"slug":"gpt-6-luna","visibility":"list"}]}\'; exit 0; fi\necho "fake codex: unexpected subcommand: $*" >&2; exit 1\n');
    chmodSync(join(withCodex, 'codex'), 0o755);
    const codexEnv = { PATH: `${withCodex}:/usr/bin:/bin` };
    await check('A6 lmctl autorun --save-only URL adapts kimi to the installed codex and saves the mapped script without running it', async () => {
      const out = join(root, 'autorun-out');
      mkdirSync(out);
      const r = await lmctl(['autorun', '--save-only', `${site.url}/role.lms`], { cwd: out, env: codexEnv });
      const saved = readdirSync(out);
      const mapped = saved.length === 1 ? readFileSync(join(out, saved[0]), 'utf8') : '';
      const a = (y) => {
        assert.equal(y.status, 0, y.stderr);
        assert.match(y.stdout, /^Suggested provider\/model substitutions:\n  Lead: kimi\/Kimi-K2\.5 -> codex\/gpt-6-luna$/m);
        assert.match(y.stdout, /^Saved mapped script: \S+\.lms$/m);
        assert.equal(y.mapped, '// autorun-role: Lead provider=codex model=gpt-6-luna\nprintln("ROLE:" + "codex" + "/" + "gpt-6-luna");\n');
        assert.doesNotMatch(y.stdout, /^ROLE:/m, 'save-only must not run the script');
      };
      controls(a, { ...r, mapped }, [['not adapted', edit('stdout', 'codex/gpt-6-luna', 'kimi/Kimi-K2.5')], ['placeholder left', edit('mapped', '"codex"', '"@role(Lead.provider)"')], ['ran anyway', edit('stdout', /^/, 'ROLE:codex/gpt-6-luna\n')]]);
    });
    await check('A7 lmctl autorun URL without a terminal offers the substitution and refuses to guess (exit 1)', async () => {
      const r = await lmctl(['autorun', `${site.url}/role.lms`], { cwd: join(root, 'autorun-out'), env: codexEnv });
      const a = (y) => {
        assert.equal(y.status, 1);
        assert.match(y.stdout, /Lead: kimi\/Kimi-K2\.5 -> codex\/gpt-6-luna/);
        assert.match(y.stderr, /Choose accept, edit, or save \[accept\/edit\/save\]: Run interactively or use an explicit command/);
        assert.doesNotMatch(y.stdout, /^ROLE:/m);
      };
      controls(a, r, [['exit 0', set('status', 0)], ['no offer', set('stdout', '')], ['ran unadapted', edit('stdout', /^/, 'ROLE:@role(Lead.provider)\n')]]);
    });
  }
  await new Promise((resolve) => site.server.close(resolve));

  // ---- B. no-API install through the published lmctl --------------------------------------------------------
  const schema = readFileSync(join(import.meta.dirname, 'fixtures', 'router.dsl.json'));
  const schemaFile = join(root, 'router.dsl.json');
  writeFileSync(schemaFile, schema);
  const os = { linux: 'linux', darwin: 'macos' }[process.platform];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  if (!os || !arch) {
    skip('B no-API install', `no release asset naming for ${process.platform}-${process.arch}`);
  } else {
    const asset = `fakehost-${os}-${arch}`;
    const hostScript = (ver) => `#!/bin/sh\n# fakehost ${ver}\nif [ "$1" = --lmcode-schema ] && [ "$2" = --json ]; then exec cat ${JSON.stringify(schemaFile)}; fi\nif [ "$1" = --version ]; then echo "fakehost ${ver}"; exit 0; fi\nif [ "$1" = --lmcode ]; then [ -f "$2" ] || exit 5; echo "host ${ver} ran $0"; echo LMCODE_RETURN_BEGIN; echo '{"ok":true,"result":null}'; echo LMCODE_RETURN_END; exit 0; fi\nexit 2\n`;
    const sha = (text) => createHash('sha256').update(text).digest('hex');
    // tag -> { bytes, sums: 'good' | 'bad' | 'none' }
    const releases = new Map([
      ['v1.0.0', { bytes: hostScript('1.0.0'), sums: 'good' }],
      ['v2.0.0-bad', { bytes: hostScript('2.0.0'), sums: 'bad' }],
      ['v3.0.0-nosum', { bytes: hostScript('3.0.0'), sums: 'none' }],
      ['v4.0.0', { bytes: hostScript('4.0.0'), sums: 'good' }],
    ]);
    const state = { latest: 'v4.0.0', rateLimited: false };
    const gh = [];
    const api = [];
    const repo = '/acme/fakehost';
    const github = await listen((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      gh.push(`${req.method} ${path}`);
      const limited = () => { res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) }); res.end('{"message":"API rate limit exceeded for 127.0.0.1."}'); };
      if (path === `${repo}/releases/latest`) {
        if (state.rateLimited) return limited();
        res.writeHead(302, { location: `${repo}/releases/tag/${state.latest}` }); res.end(); return;
      }
      if (path.startsWith(`${repo}/releases/tag/`)) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>release</html>'); return; }
      if (path.startsWith(`${repo}/releases/expanded_assets/`)) { res.writeHead(404); res.end(); return; }   // no page digest
      const m = new RegExp(`^${repo}/releases/download/([^/]+)/(.+)$`).exec(path);
      if (m) {
        const rel = releases.get(decodeURIComponent(m[1]));
        const name = decodeURIComponent(m[2]);
        if (!rel) { res.writeHead(404); res.end('Not Found'); return; }
        if (name === 'SHA256SUMS') {
          if (rel.sums === 'none') { res.writeHead(404); res.end('Not Found'); return; }
          const digest = rel.sums === 'good' ? sha(rel.bytes) : 'f'.repeat(64);
          res.writeHead(302, { location: `/objects/${m[1]}/SHA256SUMS` }); res.end(); rel.sumsText = `${'0'.repeat(64)}  LICENSE\n${digest}  ${asset}\n`; return;
        }
        if (name === asset) { res.writeHead(302, { location: `/objects/${m[1]}/${asset}` }); res.end(); return; }
        res.writeHead(404); res.end('Not Found'); return;
      }
      const o = /^\/objects\/([^/]+)\/(.+)$/.exec(path);
      if (o) {
        const rel = releases.get(decodeURIComponent(o[1]));
        if (rel && o[2] === 'SHA256SUMS') { res.writeHead(200); res.end(rel.sumsText); return; }
        if (rel && o[2] === asset) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(rel.bytes); return; }
      }
      res.writeHead(404); res.end('Not Found');
    });
    const apiServer = await listen((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      api.push(`${req.method} ${path}`);
      if (state.rateLimited) { res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' }); res.end('{"message":"API rate limit exceeded"}'); return; }
      const t = /^\/repos\/acme\/fakehost\/releases\/tags\/(.+)$/.exec(path);
      if (t && releases.has(decodeURIComponent(t[1]))) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tag_name: decodeURIComponent(t[1]), assets: [{ name: asset, digest: null, url: `${github.url}/unused` }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"Not Found"}');
    });
    const cache = join(root, 'tool-cache');
    const installEnv = { LMSCRIPT_GITHUB_HTTP: github.url, LMSCRIPT_GITHUB_API: apiServer.url, LMSCRIPT_TOOL_CACHE: cache, LMSCRIPT_GH: '' };
    const work = join(root, 'install-work');
    mkdirSync(work);
    const router = 'if (req.method() == "GET") {\n  res.status(200);\n  res.body(now_date());\n} else {\n  res.status(405);\n  res.body("method not allowed");\n}';
    const script = (name, spec) => {
      const file = join(work, name);
      writeFileSync(file, `s = load_schema(cli="fakehost" install="${spec}");\np = _lmcode_ s;\n${router}\nend _lmcode_\nr = run_lmcode(p);\nrequire(r.ok, "host failed");\n`);
      return file;
    };
    const runInstall = async (file, env = {}) => {
      const g = gh.length;
      const p = api.length;
      const r = await lmctl(['script', file], { cwd: work, env: { ...installEnv, ...env } });
      return { ...r, gh: gh.slice(g), api: api.slice(p) };
    };
    const pinnedFile = script('pinned.lms', 'github:acme/fakehost@v1.0.0');
    const pinnedBinary = join(cache, 'github/acme/fakehost/v1.0.0/fakehost');

    await check('B1 pinned install: SHA256SUMS then the asset from github.com URLs, zero API requests, the host runs', async () => {
      const r = await runInstall(pinnedFile);
      const a = (y) => {
        assert.equal(y.status, 0, y.stderr);
        assert.equal(y.stdout, `host 1.0.0 ran ${pinnedBinary}\n`);
        assert.deepEqual(y.gh, [`GET ${repo}/releases/download/v1.0.0/SHA256SUMS`, 'GET /objects/v1.0.0/SHA256SUMS', `GET ${repo}/releases/download/v1.0.0/${asset}`, `GET /objects/v1.0.0/${asset}`]);
        assert.deepEqual(y.api, [], 'no api.github.com-style request');
        assert.doesNotMatch(y.stderr, /WARNING/);
      };
      controls(a, r, [['an API call', (y) => ({ ...y, api: ['GET /repos/acme/fakehost/releases/tags/v1.0.0'] })], ['no checksum read', (y) => ({ ...y, gh: y.gh.slice(2) })], ['exit 1', set('status', 1)], ['other binary', edit('stdout', '1.0.0 ran', '9.9.9 ran')]]);
      assert.deepEqual(readdirSync(join(cache, 'github/acme/fakehost/v1.0.0')).sort(), ['fakehost', 'fakehost.release.json'], 'binary and release record only, no temp file');
      assert.equal(sha(readFileSync(pinnedBinary)), sha(releases.get('v1.0.0').bytes));
    });
    await check('B2 pinned cache hit: a second run makes no request to github.com or the API', async () => {
      const r = await runInstall(pinnedFile);
      const a = (y) => { assert.equal(y.status, 0, y.stderr); assert.equal(y.stdout, `host 1.0.0 ran ${pinnedBinary}\n`); assert.deepEqual(y.gh, []); assert.deepEqual(y.api, []); };
      controls(a, r, [['re-downloaded', (y) => ({ ...y, gh: [`GET ${repo}/releases/download/v1.0.0/${asset}`] })], ['looked up', (y) => ({ ...y, api: ['GET /repos/acme/fakehost/releases/latest'] })]]);
    });
    await check('B3 a tampered cached binary is refused, not run and not silently re-downloaded', async () => {
      const good = readFileSync(pinnedBinary);
      writeFileSync(pinnedBinary, Buffer.concat([good, Buffer.from('# swapped\n')]));
      let r;
      try { r = await runInstall(pinnedFile); } finally { writeFileSync(pinnedBinary, good); }
      const a = (y) => { assert.notEqual(y.status, 0); assert.match(y.stderr, /the cached fakehost no longer matches the recorded install \(recorded sha256 [0-9a-f]{64}, found [0-9a-f]{64}\); refusing to run it/); assert.doesNotMatch(y.stdout, /^host \d/m); assert.deepEqual(y.gh, []); };
      controls(a, r, [['exit 0', set('status', 0)], ['ran it', edit('stdout', /^/, 'host 1.0.0 ran\n')], ['fetched a replacement', (y) => ({ ...y, gh: ['GET /objects/v1.0.0/x'] })]]);
    });
    await check('B4 SHA-256 mismatch: refused with both digests and their source, exit non-zero, nothing cached, no API request', async () => {
      const r = await runInstall(script('bad.lms', 'github:acme/fakehost@v2.0.0-bad'));
      const dir = join(cache, 'github/acme/fakehost/v2.0.0-bad');
      const a = (y) => {
        assert.notEqual(y.status, 0);
        assert.match(y.stderr, new RegExp(`install github:acme/fakehost@v2\\.0\\.0-bad: release asset ${esc(asset)} SHA-256 mismatch: expected f{64}, downloaded ${sha(releases.get('v2.0.0-bad').bytes)}; refusing to install it \\(the expected digest is from SHA256SUMS\\)`));
        assert.doesNotMatch(y.stdout, /^host \d/m);
        assert.deepEqual(y.left, []);
        assert.deepEqual(y.api, []);
      };
      controls(a, { ...r, left: existsSync(dir) ? readdirSync(dir) : [] }, [['installed anyway', (y) => ({ ...y, left: ['fakehost'] })], ['exit 0', set('status', 0)], ['digest source lost', edit('stderr', 'from SHA256SUMS', 'from somewhere')]]);
    });
    await check('B5 no checksum anywhere: installs UNVERIFIED with exactly one warning listing every source; the warm run is silent', async () => {
      const file = script('nosum.lms', 'github:acme/fakehost@v3.0.0-nosum');
      const cold = await runInstall(file);
      const warm = await runInstall(file);
      const warning = `lmscript: WARNING: github:acme/fakehost@v3.0.0-nosum: no SHA-256 checksum for ${asset} was found (tried SHA256SUMS, ${asset}.sha256, a digest on the github.com release page, an asset digest in the GitHub API); the binary was installed UNVERIFIED.`;
      const a = ({ c, w }) => {
        assert.equal(c.status, 0, c.stderr);
        assert.match(c.stdout, /^host 3\.0\.0 ran \S+\/v3\.0\.0-nosum\/fakehost$/m);
        assert.equal(c.stderr.split('\n').filter((l) => l.includes('WARNING')).length, 1, 'warned once');
        assert.ok(c.stderr.includes(warning), c.stderr);
        // the API is the documented last digest source: one tags lookup, nothing else
        assert.deepEqual(c.api, ['GET /repos/acme/fakehost/releases/tags/v3.0.0-nosum']);
        assert.equal(w.status, 0, w.stderr);
        assert.doesNotMatch(w.stderr, /WARNING/);
        assert.deepEqual([...w.gh, ...w.api], []);
      };
      controls(a, { c: cold, w: warm }, [['warned twice', (y) => ({ ...y, c: { ...y.c, stderr: `${y.c.stderr}${warning}\n` } })], ['silent', (y) => ({ ...y, c: { ...y.c, stderr: '' } })], ['warm warns again', (y) => ({ ...y, w: { ...y.w, stderr: warning } })], ['extra API calls', (y) => ({ ...y, c: { ...y.c, api: [...y.c.api, 'GET /repos/acme/fakehost/releases/latest'] } })]]);
    });
    const latestFile = script('latest.lms', 'github:acme/fakehost@latest');
    const latestBinary = join(cache, 'github/acme/fakehost/latest/fakehost');
    await check('B6 @latest: the newest tag comes from the releases/latest redirect, the host reports that version, zero API requests', async () => {
      const r = await runInstall(latestFile);
      const a = (y) => {
        assert.equal(y.status, 0, y.stderr);
        assert.equal(y.stdout, `host 4.0.0 ran ${latestBinary}\n`);
        assert.equal(y.gh[0], `HEAD ${repo}/releases/latest`);
        assert.ok(y.gh.includes(`GET /objects/v4.0.0/${asset}`));
        assert.deepEqual(y.api, []);
      };
      controls(a, r, [['API used for latest', (y) => ({ ...y, api: ['GET /repos/acme/fakehost/releases/latest'] })], ['no redirect lookup', (y) => ({ ...y, gh: y.gh.slice(1) })], ['old version', edit('stdout', 'host 4.0.0', 'host 1.0.0')]]);
    });
    await check('B7 @latest within the check TTL: no request at all', async () => {
      const r = await runInstall(latestFile);
      const a = (y) => { assert.equal(y.status, 0, y.stderr); assert.equal(y.stdout, `host 4.0.0 ran ${latestBinary}\n`); assert.deepEqual([...y.gh, ...y.api], []); };
      controls(a, r, [['rechecked', (y) => ({ ...y, gh: [`HEAD ${repo}/releases/latest`] })]]);
    });
    await check('B8 rate-limited (403) newest-release check with a warm cache: one warning naming the rate limit, the cached host runs', async () => {
      state.rateLimited = true;
      let r;
      try { r = await runInstall(latestFile, { LMSCRIPT_INSTALL_CACHE_TTL_MS: '0' }); } finally { state.rateLimited = false; }
      const a = (y) => {
        assert.equal(y.status, 0, y.stderr);
        assert.equal(y.stdout, `host 4.0.0 ran ${latestBinary}\n`);
        const lines = y.stderr.split('\n').filter((l) => l.startsWith('lmscript: warning:'));
        assert.equal(lines.length, 1, y.stderr);
        assert.match(lines[0], /could not check GitHub for a newer release; using the cached fakehost v4\.0\.0 \(it still matches its install record\)/);
        assert.match(y.stderr, /GitHub rate limit reached: Latest release lookup got HTTP 403 from 127\.0\.0\.1:\d+/);
        assert.match(y.stderr, /Remedies: export GITHUB_TOKEN=<token>/);
        assert.ok(!y.gh.some((l) => l.includes('/objects/')), 'nothing downloaded');
      };
      controls(a, r, [['failed instead', set('status', 1)], ['two warnings', (y) => ({ ...y, stderr: `${y.stderr}lmscript: warning: again\n` })], ['no rate-limit detail', edit('stderr', 'rate limit reached', 'error')], ['re-downloaded', (y) => ({ ...y, gh: [...y.gh, `GET /objects/v4.0.0/${asset}`] })]]);
    });
    await check('B9 rate-limited (403) with a cold cache: fails, names the rate limit and that nothing is cached to fall back on', async () => {
      state.rateLimited = true;
      let r;
      try { r = await runInstall(latestFile, { LMSCRIPT_TOOL_CACHE: join(root, 'cold-cache') }); } finally { state.rateLimited = false; }
      const a = (y) => {
        assert.notEqual(y.status, 0);
        assert.match(y.stderr, /GitHub rate limit reached/);
        assert.match(y.stderr, /No cached fakehost to fall back on\./);
        assert.doesNotMatch(y.stdout, /^host \d/m);
        assert.equal(existsSync(join(root, 'cold-cache/github/acme/fakehost/latest/fakehost')), false);
      };
      controls(a, r, [['exit 0', set('status', 0)], ['no fallback note', edit('stderr', 'No cached fakehost to fall back on.', '')], ['ran', edit('stdout', /^/, 'host 4.0.0 ran\n')]]);
    });

    // ---- C. lmctl script modes -----------------------------------------------------------------------------
    await check('C1 lmctl script --version prints the lmscript version of this release', async () => {
      const r = await lmctl(['script', '--version']);
      const a = (y) => { assert.equal(y.status, 0); assert.equal(y.stdout.trim(), `lmscript ${version}`); };
      controls(a, r, [['other version', set('stdout', 'lmscript 0.0.1\n')], ['exit 1', set('status', 1)]]);
    });
    writeFileSync(join(work, 'good.lms'), 'x = 1;\nwrite_file("check-side-effect.txt", "x");\nprintln("OK:" + x);\n');
    writeFileSync(join(work, 'syntax.lms'), 'x = 1;\ny = x + ;\n');
    writeFileSync(join(work, 'arity.lms'), 'n = len(5, 6, 7);\n');
    for (const mode of ['--check', '--lint']) {
      await check(`C2 lmctl script ${mode}: a valid script exits 0 without running; syntax and arity errors exit 2 with file:line:column`, async () => {
        const good = await lmctl(['script', mode, 'good.lms'], { cwd: work });
        const syntax = await lmctl(['script', mode, 'syntax.lms'], { cwd: work });
        const arity = await lmctl(['script', mode, 'arity.lms'], { cwd: work });
        const a = (y) => {
          assert.equal(y.good.status, 0, y.good.stderr);
          assert.equal(y.good.stdout, '');
          assert.equal(y.effect, false, `${mode} must not run the script`);
          assert.equal(y.syntax.status, 2);
          assert.match(y.syntax.stderr, /^error:\S*syntax\.lms:2:9: Unexpected token ';' in expression$/m);
          assert.equal(y.arity.status, 2);
          assert.match(y.arity.stderr, /^error:\S*arity\.lms:1:5: Function 'len' expects 1 argument\(s\), but received 3$/m);
        };
        controls(a, { good, syntax, arity, effect: existsSync(join(work, 'check-side-effect.txt')) }, [
          ['ran the script', set('effect', true)], ['printed output', (y) => ({ ...y, good: { ...y.good, stdout: 'OK:1\n' } })],
          ['syntax exit 0', (y) => ({ ...y, syntax: { ...y.syntax, status: 0 } })], ['location lost', (y) => ({ ...y, arity: { ...y.arity, stderr: 'error: bad' } })],
        ]);
      });
    }
    await check('C3 lmctl script --dry-run plans without running (no side effect, PLAN complete)', async () => {
      const r = await lmctl(['script', '--dry-run', 'good.lms'], { cwd: work });
      const a = (y) => { assert.equal(y.status, 0, y.stderr); assert.match(y.stdout, /^PLAN complete$/m); assert.match(y.stdout, /handled println \["OK:1"\]/); assert.equal(y.effect, false); };
      controls(a, { ...r, effect: existsSync(join(work, 'check-side-effect.txt')) }, [['ran', set('effect', true)], ['no plan', set('stdout', 'OK:1\n')]]);
    });
    await check('C4 --check and --lint of an @latest load_schema(cli= install=) script with a cold cache never use the network', async () => {
      const results = [];
      for (const mode of ['--check', '--lint']) {
        const g = gh.length;
        const p = api.length;
        const r = await lmctl(['script', mode, latestFile], { cwd: work, env: { ...installEnv, LMSCRIPT_TOOL_CACHE: join(root, 'cold-cache-2') } });
        results.push({ ...r, requests: [...gh.slice(g), ...api.slice(p)] });
      }
      const a = (rs) => {
        for (const y of rs) {
          assert.equal(y.status, 2);
          assert.match(y.stderr, /not in the tool cache, and check, lint, dry-run and help never use the network for @latest; run the script once to install it, or pin a tag/);
          assert.deepEqual(y.requests, []);
        }
      };
      controls(a, results, [['a request', (rs) => rs.map((y) => ({ ...y, requests: [`HEAD ${repo}/releases/latest`] }))], ['exit 0', (rs) => rs.map((y) => ({ ...y, status: 0 }))]]);
    });
    await check('C5 --check of the pinned install script with a warm cache exits 0 and makes no request', async () => {
      const g = gh.length;
      const p = api.length;
      const r = await lmctl(['script', '--check', pinnedFile], { cwd: work, env: installEnv });
      const a = (y) => { assert.equal(y.status, 0, y.stderr); assert.deepEqual(y.requests, []); };
      controls(a, { ...r, requests: [...gh.slice(g), ...api.slice(p)] }, [['a request', set('requests', ['GET x'])], ['exit 2', set('status', 2)]]);
    });
    await new Promise((resolve) => github.server.close(resolve));
    await new Promise((resolve) => apiServer.server.close(resolve));
  }

  await check('no non-loopback DNS lookup or fetch was attempted by lmctl or any node child it started', async () => {
    const log = existsSync(guardLog) ? readFileSync(guardLog, 'utf8') : '';
    controls((t) => assert.equal(t, ''), log, [['a refused lookup', () => '123 dns github.com\n']]);
    // and the guard works: a non-loopback lookup under it is refused and logged
    const probe = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', guard, '-e', "require('node:dns').lookup('github.com', (e) => process.exit(e ? 7 : 0))"]);
      child.on('close', resolve);
    });
    assert.equal(probe, 7);
    assert.match(readFileSync(guardLog, 'utf8'), /dns github\.com/);
  });
} catch (error) {
  failed += 1;
  console.log(`FAIL setup: ${error?.stack ?? error}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const total = passed + failed + skipped;
console.log(skipped > 0
  ? `${total} assertions: ${passed} pass, ${skipped} skipped, ${failed} fail`
  : `${total} assertions: ${passed} pass, ${failed} fail`);
process.exitCode = failed > 0 ? 1 : 0;

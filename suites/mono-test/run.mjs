#!/usr/bin/env node
// Runs the ported lmctl-mono-test suites against an INSTALLED (published) lmctl.
//   node run.mjs [--only id,id] [--list] [--allowlist FILE] [--today YYYY-MM-DD] [--control broken-bin]
// Env: LMCTL_BIN (default: lmctl on PATH), LMSCRIPT_BIN (default: lmscript next to it), INTEGRATION_BIN (extra PATH dir
// holding miniplayer, lmmock). Every suite runs in a private HOME / LMCTL_DB / cache with the lmctl session markers removed
// and a clean PATH (node, the lmctl bin dir, INTEGRATION_BIN, /usr/bin, /bin): provider CLIs of the host stay invisible.
//
// Verdicts: PASS | ALLOWED (non-zero exit, every failure line covered by an unexpired allowlist entry) |
//           FAIL (an uncovered failure line, an expired entry, or a non-zero exit with no recognizable failure line).
// There are no timeouts here; the job-level timeout-minutes is the only guard.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(name);

const config = JSON.parse(fs.readFileSync(path.join(here, 'suites.json'), 'utf8'));
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
const control = opt('--control');
if (control && control !== 'broken-bin') { console.error(`unknown --control ${control}`); process.exit(2); }
let suites = config.suites.filter((s) => !only || only.has(s.id));
if (control) suites = suites.filter((s) => s.usesLmctl);
if (has('--list')) { for (const s of suites) console.log(`${s.id}\t${s.kind}\t${s.file}`); process.exit(0); }
if (only) for (const id of only) if (!config.suites.some((s) => s.id === id)) { console.error(`unknown suite ${id}`); process.exit(2); }

const today = opt('--today', new Date().toISOString().slice(0, 10));
const allowlistPath = opt('--allowlist', path.join(here, 'allowlist.json'));
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
for (const e of allowlist) {
  for (const k of ['suite', 'match', 'reason', 'owner', 'expires']) {
    if (typeof e[k] !== 'string' || !e[k]) { console.error(`allowlist entry lacks ${k}: ${JSON.stringify(e)}`); process.exit(2); }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) { console.error(`allowlist expires must be YYYY-MM-DD: ${JSON.stringify(e)}`); process.exit(2); }
}

const which = (cmd, searchPath) => {
  for (const dir of (searchPath || '').split(path.delimiter)) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return fs.realpathSync(p); } catch { /* next */ }
  }
  return null;
};

let lmctlBin = process.env.LMCTL_BIN || which('lmctl', process.env.PATH);
if (!lmctlBin) { console.error('LMCTL_BIN is not set and lmctl is not on PATH'); process.exit(2); }
let lmscriptBin = process.env.LMSCRIPT_BIN || path.join(path.dirname(lmctlBin), 'lmscript');
const scratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mono-test-'));
if (control === 'broken-bin') {
  // A lmctl that exits 0 and prints nothing: any suite that still passes asserts nothing about lmctl.
  const shims = path.join(scratch, 'broken-bin');
  fs.mkdirSync(shims, { recursive: true });
  for (const name of ['lmctl', 'lmscript']) {
    fs.writeFileSync(path.join(shims, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  lmctlBin = path.join(shims, 'lmctl');
  lmscriptBin = path.join(shims, 'lmscript');
}

const nodeBin = process.execPath;
const pathValue = [path.dirname(lmctlBin), path.dirname(nodeBin), process.env.INTEGRATION_BIN, '/usr/bin', '/bin'].filter(Boolean).join(path.delimiter);
const testsCwd = path.join(here, 'lmctl-test');

// Primary failure lines are FAIL lines, node:test failures and "  - finding" lines. Only when a failing run printed none of them
// are bare Error/AssertionError lines used, so an assertion that merely echoes a whole report is not mistaken for a new failure.
const failureLines = (output) => {
  const lines = output.split('\n').map((l) => l.replace(/\r$/, ''));
  const primary = lines.filter((l) => /^FAIL\b/.test(l) || /^\s*✖ /.test(l) && !/failing tests:/.test(l) || /^\s+- \S/.test(l) || /^not ok\b/.test(l));
  return primary.length ? primary : lines.filter((l) => /^(Assertion)?Error\b/.test(l));
};

const runOne = (suite) => new Promise((resolve) => {
  const work = fs.mkdtempSync(path.join(scratch, `${suite.id}-`));
  fs.mkdirSync(path.join(work, 'home'), { recursive: true });
  const env = {
    PATH: pathValue,
    HOME: path.join(work, 'home'),
    XDG_CACHE_HOME: path.join(work, 'cache'),
    LMCTL_DB: path.join(work, 'home', 'lmctl.db'),
    LMCTL_BIN: lmctlBin,
    LMSCRIPT_BIN: lmscriptBin,
    NODE_BIN: nodeBin,
    NODE_DIR: path.dirname(nodeBin),
    TMPDIR: work,
    LANG: 'C.UTF-8',
  };
  // miniplayer-tools wants the JS entry, miniplayer-mock accepts a path or a command (see actions/setup/install-miniplayer.sh).
  if ((suite.needs || []).includes('miniplayer') && process.env.INTEGRATION_MINIPLAYER_JS) env.MINIPLAYER_BIN = process.env.INTEGRATION_MINIPLAYER_JS;
  let cmd;
  if (suite.kind === 'lmctl-script') cmd = [lmctlBin, 'script', path.join('tests', suite.file)];
  else if (suite.kind === 'node') cmd = [nodeBin, path.join('tests', suite.file)];
  else if (suite.kind === 'node-test') {
    cmd = [nodeBin, '--test', ...(suite.skipTests || []).map((p) => `--test-skip-pattern=${p}`), path.join('tests', suite.file)];
  } else { resolve({ suite, code: 2, output: `unknown kind ${suite.kind}`, lines: [] }); return; }
  for (const need of suite.needs || []) {
    if (!which(need, pathValue)) { resolve({ suite, code: 127, output: `FAIL suite needs ${need} on PATH`, lines: [`FAIL suite needs ${need} on PATH`] }); return; }
  }
  const child = spawn(cmd[0], cmd.slice(1), { cwd: testsCwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.on('error', (e) => resolve({ suite, code: 127, output: `FAIL cannot start: ${e.message}`, lines: [`FAIL cannot start: ${e.message}`] }));
  child.on('close', (code) => {
    const actualCode = code ?? 1;
    if (control === 'broken-bin' && suite.kind === 'lmctl-script' && actualCode === 0 && output.trim() === '') {
      const failure = 'FAIL lmctl script runner returned 0 without executing its assertions';
      resolve({ suite, code: 1, output: failure, lines: [failure] });
      return;
    }
    resolve({ suite, code: actualCode, output, lines: failureLines(output) });
  });
});

const classify = (r) => {
  if (r.code === 0) return { verdict: 'PASS', notes: [] };
  const entries = allowlist.filter((e) => e.suite === r.suite.id);
  const notes = [];
  if (r.lines.length === 0) return { verdict: 'FAIL', notes: [`exit ${r.code} with no recognizable failure line (unclassified failure)`] };
  let uncovered = 0;
  for (const line of r.lines) {
    const hit = entries.find((e) => line.includes(e.match));
    if (!hit) { uncovered++; notes.push(`uncovered: ${line.slice(0, 200)}`); continue; }
    if (hit.expires < today) { uncovered++; notes.push(`allowlist entry expired ${hit.expires} (owner ${hit.owner}): ${line.slice(0, 160)}`); continue; }
    notes.push(`allowed until ${hit.expires} (${hit.owner}): ${line.slice(0, 160)}`);
  }
  return { verdict: uncovered ? 'FAIL' : 'ALLOWED', notes };
};

const results = [];
for (const suite of suites) {
  const started = Date.now();
  const r = await runOne(suite);
  const c = classify(r);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ id: suite.id, code: r.code, secs, ...c, output: r.output });
  console.log(`${c.verdict.padEnd(7)} ${suite.id} (exit ${r.code}, ${secs}s)`);
  for (const n of c.notes) console.log(`        ${n}`);
  if (c.verdict === 'FAIL' && !control) console.log(r.output.split('\n').slice(-25).map((l) => `        | ${l}`).join('\n'));
}

let exitCode = 0;
if (control === 'broken-bin') {
  const vacuous = results.filter((r) => r.verdict === 'PASS').map((r) => r.id);
  console.log(`\nbroken-bin control: ${results.length - vacuous.length} of ${results.length} lmctl-driven suites went red`);
  if (vacuous.length) { console.log(`VACUOUS (green against a lmctl that does nothing): ${vacuous.join(', ')}`); exitCode = 1; }
} else {
  const stale = [];
  for (const e of allowlist) {
    const r = results.find((x) => x.id === e.suite);
    if (r && r.verdict === 'PASS') stale.push(`${e.suite}: "${e.match}" no longer fails; remove the entry`);
  }
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const allowed = results.filter((r) => r.verdict === 'ALLOWED').length;
  const fail = results.filter((r) => r.verdict === 'FAIL').length;
  const line = `mono-test port: ${pass} pass, ${allowed} allowed, ${fail} fail of ${results.length} suites (lmctl ${spawnSync(lmctlBin, ['--version'], { encoding: 'utf8' }).stdout.trim() || 'unknown'})`;
  console.log(`\n${line}`);
  for (const s of stale) console.log(`notice: ${s}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${r.id} | ${r.verdict} | ${r.secs}s |`).join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${line}\n\n| suite | verdict | time |\n|---|---|---|\n${rows}\n\n${stale.map((s) => `- notice: ${s}`).join('\n')}\n`);
  }
  if (fail) exitCode = 1;
}
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(exitCode);

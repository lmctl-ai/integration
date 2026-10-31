import { runIntentCases } from './intent-cases.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'lmctl-offline-'));
const fakeBin = join(root, 'fake-provider-bin');
mkdirSync(fakeBin, { recursive: true });

// Issue 084 / 062: Provider CLIs must never be called live during offline test execution.
// Fake binaries guarantee deterministic responses offline without network or quota usage:
// - codex: handles `--version` and `debug models`, exits non-zero on any other subcommand
// - agy: handles `--version` and `models`, exits non-zero on any other subcommand
// - claude: handles `--version`, exits non-zero on any other subcommand
// - kimi: exits non-zero on `--version` so it is not detected as installed without config
writeFileSync(join(fakeBin, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.0.0-fake"
  exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  echo '{"models":[{"slug":"gpt-6-luna","visibility":"list"},{"slug":"gpt-6.1-sol","visibility":"list"}]}'
  exit 0
fi
echo "fake codex: unexpected subcommand: $*" >&2
exit 1
`);
chmodSync(join(fakeBin, 'codex'), 0o755);

writeFileSync(join(fakeBin, 'agy'), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "agy 0.0.0-fake"
  exit 0
fi
if [ "$1" = "models" ]; then
  printf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\ngemini-4-argon-medium\\tGemini 4 Argon (Medium)\\n'
  exit 0
fi
echo "fake agy: unexpected subcommand: $*" >&2
exit 1
`);
chmodSync(join(fakeBin, 'agy'), 0o755);

writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "claude 0.0.0-fake"
  exit 0
fi
echo "fake claude: unexpected subcommand: $*" >&2
exit 1
`);
chmodSync(join(fakeBin, 'claude'), 0o755);

writeFileSync(join(fakeBin, 'kimi'), `#!/bin/sh
echo "fake kimi: not installed" >&2
exit 1
`);
chmodSync(join(fakeBin, 'kimi'), 0o755);

const rawBin = process.env.LMCTL_BIN || 'lmctl';
let bin = rawBin;
if (!rawBin.includes('/')) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, rawBin);
    if (existsSync(candidate)) {
      bin = candidate;
      break;
    }
  }
}
const nodeBinDir = dirname(realpathSync(process.execPath));
const lmctlBinDir = dirname(bin);
const realLmctlBinDir = existsSync(bin) ? dirname(realpathSync(bin)) : lmctlBinDir;

const isolatedPath = [
  fakeBin,
  lmctlBinDir,
  realLmctlBinDir,
  nodeBinDir,
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
].filter((d, i, a) => Boolean(d) && existsSync(d) && a.indexOf(d) === i).join(delimiter);

const allowedEnvKeys = new Set([
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'CI',
]);

function sanitizeChildEnv(base = process.env, overrides = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      key.startsWith('LMCTL_') ||
      key.startsWith('XDG_') ||
      key.startsWith('KIMI_') ||
      key.startsWith('CLAUDE_') ||
      key.startsWith('CODEX_') ||
      key.startsWith('AGY_') ||
      key.startsWith('ANTIGRAVITY_') ||
      key.startsWith('OPENCODE_') ||
      key.startsWith('GEMINI_') ||
      /^(?:COPILOT_HOME|HERMES_HOME|HERMES_YOLO_MODE|DSH_HOME|QWEN_HOME|MINIPLAYER_HOME|LMSCRIPT_BIN)$/.test(key)
    ) {
      continue;
    }
    if (allowedEnvKeys.has(key)) {
      clean[key] = value;
    }
  }
  return Object.assign(clean, overrides);
}

function dirSnapshot(dir) {
  if (!dir || !existsSync(dir)) return null;
  const entries = readdirSync(dir).sort();
  const hashes = entries.map((name) => {
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(full);
      return `${name}:symlink[${target}]`;
    }
    if (stat.isDirectory()) {
      return `${name}:dir[${dirSnapshot(full)}]`;
    }
    const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
    return `${name}:${hash}`;
  });
  return hashes.join('\n');
}

const env = sanitizeChildEnv(process.env, {
  HOME: join(root, 'home'),
  LMCTL_DB: join(root, 'state.db'),
  PATH: isolatedPath,
  LMCTL_BIN: bin,
});
if (process.env.LMSCRIPT_BIN) env.LMSCRIPT_BIN = process.env.LMSCRIPT_BIN;

let passed = 0;
let skipped = 0;

function run(argv) {
  assert.equal(argv[0], 'lmctl');
  return execFileSync(bin, argv.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 60000 });
}

function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function skip(name, reason) {
  skipped += 1;
  console.log(`SKIP ${name}: ${reason}`);
}

async function probeNetworkReachable(host = 'lmctl.com', port = 443, timeoutMs = 800) {
  try {
    const address = await Promise.race([
      lookup(host).then((res) => res.address),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS lookup timeout')), timeoutMs)),
    ]);
    return await new Promise((resolve) => {
      const socket = createConnection({ host: address, port, timeout: timeoutMs }, () => {
        socket.destroy();
        resolve({ reachable: true });
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve({ reachable: false, reason: 'connection timeout' });
      });
      socket.on('error', (err) => {
        socket.destroy();
        resolve({ reachable: false, reason: err.message });
      });
    });
  } catch (err) {
    return { reachable: false, reason: err.message };
  }
}

try {
  check('plan emits a parseable Lead teamfile without seeding', () => {
    const output = run(["lmctl", "plan", '--member', 'Lead:codex', '--stdout', '--no-seed']);
    assert.match(output, /^_MEMBER_ .*provider=codex.*alias=Lead/m);
  });

  check('init creates a default init.toml', () => {
    const externalSnapshotBefore = process.env.LMCTL_HOME ? dirSnapshot(process.env.LMCTL_HOME) : null;
    run(["lmctl", "init"]);
    const content = readFileSync(join(root, 'home', '.lmctl', 'init.toml'), 'utf8');
    assert.match(content, /provider = "/m);
    if (process.env.LMCTL_HOME) {
      const externalSnapshotAfter = dirSnapshot(process.env.LMCTL_HOME);
      assert.equal(externalSnapshotAfter, externalSnapshotBefore, 'outer LMCTL_HOME must remain byte-identical');
    }
  });

  check('init isolates state from poisoned LMCTL_HOME and outside redirect vars', () => {
    const poisonDir = mkdtempSync(join(tmpdir(), 'lmctl-poison-'));
    // Pre-existing sentinel file in poisonDir to prove it is not overwritten or falsely failed
    const sentinelPath = join(poisonDir, 'init.toml');
    const sentinelContent = '# pre-existing operator sentinel\nfoo = "bar"\n';
    writeFileSync(sentinelPath, sentinelContent);
    // Add self-referential directory symlink to prove snapshot helper never follows it
    symlinkSync('.', join(poisonDir, 'self'));
    const snapshotBefore = dirSnapshot(poisonDir);

    const isolatedHome = join(root, 'home-poison-check');
    mkdirSync(isolatedHome, { recursive: true });
    try {
      const polluted = {
        ...process.env,
        LMCTL_HOME: poisonDir,
        LMCTL_CONFIG: poisonDir,
        CLAUDE_CONFIG_DIR: poisonDir,
        XDG_CONFIG_HOME: poisonDir,
        XDG_DATA_HOME: poisonDir,
      };
      const childEnv = sanitizeChildEnv(polluted, {
        HOME: isolatedHome,
        LMCTL_DB: join(isolatedHome, 'state.db'),
        PATH: fakeBin + delimiter + (process.env.PATH ?? ''),
      });
      assert.equal(childEnv.LMCTL_HOME, undefined, 'LMCTL_HOME must be stripped');
      assert.equal(childEnv.LMCTL_CONFIG, undefined, 'LMCTL_CONFIG must be stripped');
      assert.equal(childEnv.CLAUDE_CONFIG_DIR, undefined, 'CLAUDE_CONFIG_DIR must be stripped');
      assert.equal(childEnv.XDG_CONFIG_HOME, undefined, 'XDG_CONFIG_HOME must be stripped');
      execFileSync(bin, ['init'], { cwd: root, env: childEnv, encoding: 'utf8', timeout: 60000 });

      const snapshotAfter = dirSnapshot(poisonDir);
      assert.equal(snapshotAfter, snapshotBefore, 'poisoned LMCTL_HOME must remain untouched and byte-identical');
      assert.equal(readFileSync(sentinelPath, 'utf8'), sentinelContent, 'sentinel content must be preserved');

      const content = readFileSync(join(isolatedHome, '.lmctl', 'init.toml'), 'utf8');
      assert.match(content, /provider = "/m);
    } finally {
      rmSync(poisonDir, { recursive: true, force: true });
    }
  });

  if (/INSTALLED/.test(run(["lmctl", "init", '--help']))) {
    check('init with no provider installed errors and writes nothing (issue 062)', () => {
      // Run the installed CLI through node directly with an EMPTY PATH, so no provider binary --
      // not even one sitting beside node -- can be found.
      const which = spawnSync('sh', ['-c', 'command -v "$0"', bin], { encoding: 'utf8' }).stdout.trim();
      const script = realpathSync(which || bin);
      const home = join(root, 'home-none');
      const empty = join(root, 'empty-path');
      mkdirSync(empty, { recursive: true });
      const r = spawnSync(process.execPath, [script, 'init'], { cwd: root, encoding: 'utf8', timeout: 60000,
        env: { ...env, HOME: home, PATH: empty, LMCTL_SKIP_BINARY_CHECK: '1' } });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /no supported provider is installed -- looked for claude, codex, agy, kimi/);
      assert.equal(existsSync(join(home, '.lmctl', 'init.toml')), false, 'a refused init writes nothing');
    });
  } else {
    console.log('NOTE init installed-detection: this candidate predates mono issue 062; default-file check only');
  }

  check('lint accepts a local valid teamfile', () => {
    const file = join(root, 'valid.lmctl');
    writeFileSync(file, '_MEMBER_ alias=Lead provider=codex\n');
    assert.equal(run(["lmctl", "lint", file]).trim(), 'ok');
    assert.equal(readFileSync(file, 'utf8'), '_MEMBER_ alias=Lead provider=codex\n');
  });

  check('model command is retired and not an alias (issue 084)', () => {
    assert.throws(() => run(["lmctl", "model"]), (error) => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /command 'model' is retired; use 'models'/);
      return true;
    });
    assert.throws(() => run(["lmctl", "models", "--all"]), (error) => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /unknown flag: --all/);
      return true;
    });
    const help = run(["lmctl", "models", "--help"]);
    assert.match(help, /usage: lmctl models/);
    assert.match(help, /--old\s+Include ids known to the catalog/);
    assert.match(help, /Claude catalog ids are unverified/);
  });

  function assertModelTableRow(tableText, { model, display, status, input, output, cacheRead }) {
    const headerPattern = display !== undefined
      ? /MODEL\s+DISPLAY\s+STATUS\s+INPUT\s+OUTPUT\s+CACHE READ/
      : /MODEL\s+STATUS\s+INPUT\s+OUTPUT\s+CACHE READ/;
    assert.match(tableText, headerPattern, 'table header must include STATUS column');

    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = [escapeRe(model)];
    if (display !== undefined) parts.push(escapeRe(display));
    parts.push(escapeRe(status));
    parts.push(escapeRe(input));
    parts.push(escapeRe(output));
    parts.push(escapeRe(cacheRead));
    const rowPattern = new RegExp(`\\b${parts.join('\\s+')}\\b`);
    assert.match(tableText, rowPattern, `table row for ${model} with status ${status} and prices must match`);
  }

  function assertModelStatus(model, expectedStatus) {
    assert.ok('status' in model, 'status field must be present in JSON model');
    assert.equal(typeof model.status, 'string', 'status must be a string');
    assert.ok(['valid', 'old', 'unverified'].includes(model.status), `status '${model.status}' must be valid/old/unverified`);
    assert.equal(model.status, expectedStatus, `status must equal ${expectedStatus}`);
  }

  check('models lists native ids with USD-per-million prices and null unknowns (issue 084)', () => {
    const records = [
      {
        source: 'litellm', source_model_id: 'gpt-6-luna', provider: 'openai', mode: 'chat',
        native: { codex: 'gpt-6-luna' },
        pricing: { input_per_1m_tokens: 0, output_per_1m_tokens: 2.5, input_cache_read_per_1m_tokens: null },
      },
      {
        source: 'litellm', source_model_id: 'gemini-3.8-flash', provider: 'google', mode: 'chat',
        native: { agy: 'gemini-3.8-flash' },
        pricing: { input_per_1m_tokens: 0.75, output_per_1m_tokens: 3.75, input_cache_read_per_1m_tokens: 0.075 },
      },
      {
        source: 'litellm', source_model_id: 'claude-sonnet-5', provider: 'anthropic', mode: 'chat',
        pricing: { input_per_1m_tokens: 3, output_per_1m_tokens: 15, input_cache_read_per_1m_tokens: 0.3 },
      },
      {
        source: 'litellm', source_model_id: 'claude-offline-test', provider: 'anthropic', mode: 'chat',
        pricing: { input_per_1m_tokens: 0, output_per_1m_tokens: 3, input_cache_read_per_1m_tokens: null },
      },
      {
        source: 'litellm', source_model_id: 'catalog-only-test', provider: 'openai', mode: 'chat',
        native: { codex: 'catalog-only-test' },
        pricing: { input_per_1m_tokens: 1, output_per_1m_tokens: 5, input_cache_read_per_1m_tokens: 0.1 },
      },
    ];
    writeFileSync(join(root, 'model_list.json'), JSON.stringify({
      schema_version: 1, generated_at: '2026-10-15T00:00:00Z', records,
    }));
    writeFileSync(join(root, 'aliases.json'), JSON.stringify({ schema_version: 1, standards: [], aliases: [] }));

    const priorPin = env.LMCTL_PRICE_DATA;
    env.LMCTL_PRICE_DATA = root;
    try {
      const table = run(["lmctl", "models"]);
      assert.match(table, /USD per million tokens/);
      assert.match(table, /codex \(codex debug models\)\s+MODEL\s+STATUS\s+INPUT\s+OUTPUT\s+CACHE READ/);
      assert.match(table, /agy \(agy models\)\s+MODEL\s+DISPLAY\s+STATUS\s+INPUT\s+OUTPUT\s+CACHE READ/);
      assert.match(table, /claude \(lmprice native\.claude_code\)\s+MODEL\s+STATUS\s+INPUT\s+OUTPUT\s+CACHE READ/);

      assertModelTableRow(table, {
        model: 'gpt-6-luna', status: 'valid', input: '$0', output: '$2.5', cacheRead: 'n/a',
      });
      assertModelTableRow(table, {
        model: 'gpt-6.1-sol', status: 'valid', input: 'n/a', output: 'n/a', cacheRead: 'n/a',
      });
      assertModelTableRow(table, {
        model: 'gemini-3.8-flash-high', display: 'Gemini 3.8 Flash (High)', status: 'valid', input: '$0.75', output: '$3.75', cacheRead: '$0.075',
      });
      assertModelTableRow(table, {
        model: 'gemini-4-argon-medium', display: 'Gemini 4 Argon (Medium)', status: 'valid', input: 'n/a', output: 'n/a', cacheRead: 'n/a',
      });
      assertModelTableRow(table, {
        model: 'claude-sonnet-5', status: 'unverified', input: '$3', output: '$15', cacheRead: '$0.3',
      });

      // Mutation controls: wrong status, missing status column, wrong price must fail
      // 1. Wrong status (e.g. valid -> unverified/old, unverified -> valid)
      assert.throws(() => assertModelTableRow(table, {
        model: 'gpt-6-luna', status: 'unverified', input: '$0', output: '$2.5', cacheRead: 'n/a',
      }), /table row for gpt-6-luna/);
      assert.throws(() => assertModelTableRow(table, {
        model: 'gpt-6-luna', status: 'old', input: '$0', output: '$2.5', cacheRead: 'n/a',
      }), /table row for gpt-6-luna/);
      assert.throws(() => assertModelTableRow(table, {
        model: 'claude-sonnet-5', status: 'valid', input: '$3', output: '$15', cacheRead: '$0.3',
      }), /table row for claude-sonnet-5/);

      // 2. Missing status column in header or row
      const tableWithoutHeaderStatus = table.replace(/\bSTATUS\s+/g, '');
      assert.throws(() => assertModelTableRow(tableWithoutHeaderStatus, {
        model: 'gpt-6-luna', status: 'valid', input: '$0', output: '$2.5', cacheRead: 'n/a',
      }), /table header must include STATUS column/);

      const tableWithoutRowStatus = table.replace(/\bvalid\s+/g, '');
      assert.throws(() => assertModelTableRow(tableWithoutRowStatus, {
        model: 'gpt-6-luna', status: 'valid', input: '$0', output: '$2.5', cacheRead: 'n/a',
      }), /table row for gpt-6-luna/);

      // 3. Wrong price
      assert.throws(() => assertModelTableRow(table, {
        model: 'gpt-6-luna', status: 'valid', input: '$99', output: '$2.5', cacheRead: 'n/a',
      }), /table row for gpt-6-luna/);
      assert.throws(() => assertModelTableRow(table, {
        model: 'gpt-6-luna', status: 'valid', input: '$0', output: '$99', cacheRead: 'n/a',
      }), /table row for gpt-6-luna/);
      assert.throws(() => assertModelTableRow(table, {
        model: 'claude-sonnet-5', status: 'unverified', input: '$99', output: '$15', cacheRead: '$0.3',
      }), /table row for claude-sonnet-5/);

      // Table --old includes retired catalog-only models with status 'old'
      const codexOldTable = run(["lmctl", "models", "codex", "--old"]);
      assertModelTableRow(codexOldTable, {
        model: 'catalog-only-test', status: 'old', input: 'n/a', output: 'n/a', cacheRead: 'n/a',
      });
      assert.throws(() => assertModelTableRow(codexOldTable, {
        model: 'catalog-only-test', status: 'valid', input: 'n/a', output: 'n/a', cacheRead: 'n/a',
      }), /table row for catalog-only-test/);

      const codexData = JSON.parse(run(["lmctl", "models", "codex", "--json"]));
      assert.equal(codexData.schema_version, 2);
      assert.equal(codexData.currency, 'USD');
      assert.equal(codexData.unit, 'per_million_tokens');
      assert.equal(codexData.price_data_source, 'pinned');
      assert.equal(codexData.providers.length, 1);
      const codexSection = codexData.providers[0];
      assert.equal(codexSection.provider, 'codex');
      assert.equal(codexSection.status, 'ok');
      assert.equal(codexSection.source, 'codex debug models');
      assert.equal(codexSection.reason, null);
      assert.deepEqual(codexSection.models.map((m) => m.id), ['gpt-6-luna', 'gpt-6.1-sol']);
      assert.ok(!codexSection.models.some((m) => m.id === 'catalog-only-test'), 'catalog-only models must not be listed');
      assert.ok(codexSection.models.every((m) => m.tier === undefined), 'tier markers must be absent');

      const pricedCodex = codexSection.models.find((m) => m.id === 'gpt-6-luna');
      assert.equal(pricedCodex.display_name, null);
      assertModelStatus(pricedCodex, 'valid');
      assert.equal(pricedCodex.price_resolution, 'priced');
      assert.equal(pricedCodex.price_estimated, false);
      assert.equal(pricedCodex.pricing.input_per_1m_tokens, 0, 'known zero price must stay 0, not null');
      assert.notEqual(pricedCodex.pricing.input_per_1m_tokens, null, 'known zero price must not be null');
      assert.equal(pricedCodex.pricing.output_per_1m_tokens, 2.5);
      assert.equal(pricedCodex.pricing.input_cache_read_per_1m_tokens, null);

      const unpricedCodex = codexSection.models.find((m) => m.id === 'gpt-6.1-sol');
      assert.equal(unpricedCodex.display_name, null);
      assertModelStatus(unpricedCodex, 'valid');
      assert.equal(unpricedCodex.price_resolution, 'unknown');
      assert.equal(unpricedCodex.price_estimated, false);
      assert.equal(unpricedCodex.pricing.input_per_1m_tokens, null, 'unknown input price must be null');
      assert.notEqual(unpricedCodex.pricing.input_per_1m_tokens, 0, 'unknown price must not be fabricated as 0');
      assert.equal(unpricedCodex.pricing.output_per_1m_tokens, null, 'unknown output price must be null');
      assert.notEqual(unpricedCodex.pricing.output_per_1m_tokens, 0, 'unknown price must not be fabricated as 0');
      assert.equal(unpricedCodex.pricing.input_cache_read_per_1m_tokens, null);

      const agyData = JSON.parse(run(["lmctl", "models", "agy", "--json"]));
      assert.equal(agyData.schema_version, 2);
      const agySection = agyData.providers[0];
      assert.equal(agySection.provider, 'agy');
      assert.equal(agySection.status, 'ok');
      assert.equal(agySection.source, 'agy models');
      assert.deepEqual(agySection.models.map((m) => m.id), ['gemini-3.8-flash-high', 'gemini-4-argon-medium']);
      assert.ok(agySection.models.every((m) => m.tier === undefined), 'tier markers must be absent');

      const assertPriceEstimated = (model, expected = false) => {
        assert.ok('price_estimated' in model, 'price_estimated must be present');
        assert.equal(typeof model.price_estimated, 'boolean', 'price_estimated must be a boolean');
        assert.equal(model.price_estimated, expected, `price_estimated must equal ${expected}`);
      };

      const flash = agySection.models.find((m) => m.id === 'gemini-3.8-flash-high');
      assert.equal(flash.display_name, 'Gemini 3.8 Flash (High)');
      assertModelStatus(flash, 'valid');
      assert.equal(flash.price_resolution, 'priced');
      assert.equal(flash.price_estimated, false);
      assertPriceEstimated(flash, false);
      assert.equal(flash.pricing.input_per_1m_tokens, 0.75);
      assert.equal(flash.pricing.output_per_1m_tokens, 3.75);
      assert.equal(flash.pricing.input_cache_read_per_1m_tokens, 0.075);

      const argon = agySection.models.find((m) => m.id === 'gemini-4-argon-medium');
      assert.equal(argon.display_name, 'Gemini 4 Argon (Medium)');
      assertModelStatus(argon, 'valid');
      assert.equal(argon.price_resolution, 'unknown');
      assert.equal(argon.price_estimated, false);
      assertPriceEstimated(argon, false);
      assert.equal(argon.pricing.input_per_1m_tokens, null);
      assert.notEqual(argon.pricing.input_per_1m_tokens, 0);
      assert.equal(argon.pricing.output_per_1m_tokens, null);
      assert.notEqual(argon.pricing.output_per_1m_tokens, 0);
      assert.equal(argon.pricing.input_cache_read_per_1m_tokens, null);

      // Negative controls: missing field, wrong type, wrong value must fail
      for (const m of [flash, argon]) {
        assert.throws(() => {
          const mutant = { ...m };
          delete mutant.price_estimated;
          assertPriceEstimated(mutant, false);
        }, /price_estimated must be present|price_estimated must be a boolean/);

        assert.throws(() => {
          assertPriceEstimated({ ...m, price_estimated: 'not-a-boolean' }, false);
        }, /price_estimated must be a boolean/);
        assert.throws(() => {
          assertPriceEstimated({ ...m, price_estimated: null }, false);
        }, /price_estimated must be a boolean/);
        assert.throws(() => {
          assertPriceEstimated({ ...m, price_estimated: 0 }, false);
        }, /price_estimated must be a boolean/);

        assert.throws(() => {
          assertPriceEstimated({ ...m, price_estimated: true }, false);
        }, /price_estimated must equal false/);
      }

      const claudeData = JSON.parse(run(["lmctl", "models", "claude", "--json"]));
      assert.equal(claudeData.schema_version, 2);
      const claudeSection = claudeData.providers[0];
      assert.equal(claudeSection.provider, 'claude');
      assert.equal(claudeSection.status, 'ok');
      assert.equal(claudeSection.source, 'lmprice native.claude_code');
      const sonnet = claudeSection.models.find((m) => m.id === 'claude-sonnet-5');
      assert.ok(sonnet, 'claude-sonnet-5 must be listed in claude models');
      assertModelStatus(sonnet, 'unverified');

      const codexOldData = JSON.parse(run(["lmctl", "models", "codex", "--old", "--json"]));
      const oldCodexModel = codexOldData.providers[0].models.find((m) => m.id === 'catalog-only-test');
      assert.ok(oldCodexModel, 'catalog-only-test must be listed in codex models with --old');
      assertModelStatus(oldCodexModel, 'old');

      // Negative controls for status field: missing field, wrong type, wrong value must fail
      for (const m of [pricedCodex, flash, sonnet, oldCodexModel]) {
        assert.throws(() => {
          const mutant = { ...m };
          delete mutant.status;
          assertModelStatus(mutant, m.status);
        }, /status field must be present/);

        assert.throws(() => {
          assertModelStatus({ ...m, status: 'unexpected' }, m.status);
        }, /must be valid\/old\/unverified/);

        assert.throws(() => {
          assertModelStatus({ ...m, status: m.status === 'valid' ? 'unverified' : 'valid' }, m.status);
        }, /status must equal/);
      }
    } finally {
      writeFileSync(join(root, 'model_list.json'), JSON.stringify({
        schema_version: 1, generated_at: '2026-10-15T00:00:00Z', records,
      }));
      if (priorPin === undefined) delete env.LMCTL_PRICE_DATA;
      else env.LMCTL_PRICE_DATA = priorPin;
    }
  });

  check('partial teamfile targets show existing sessions without rewriting or seeding', () => {
    const priorPin = env.LMCTL_PRICE_DATA;
    env.LMCTL_PRICE_DATA = root;
    try {
      for (const extension of ['lmc', 'lmctl']) {
        const file = join(root, `partial.${extension}`);
        const text = '# keep\n_MEMBER_ alias=Lead provider=claude model=claude-offline-test sessionid=11111111-1111-4111-8111-111111111111\n';
        writeFileSync(file, text);
        const output = run(["lmctl", file]);
        assert.match(output, /PROVIDER.*MODEL.*RUNNING.*AGE.*CONTEXT/);
        assert.match(output, /claude-offline-test/);
        assert.equal(readFileSync(file, 'utf8'), text);
      }
      const output = run(["lmctl", 'claude/claude-offline-test']);
      assert.match(output, /claude \(lmprice native\.claude_code\)\s+MODEL\s+STATUS\s+INPUT\s+OUTPUT\s+CACHE READ/);
      assert.match(output, /claude-offline-test\s+unverified\s+\$0\s+\$3\s+n\/a/);
      assertModelTableRow(output, {
        model: 'claude-offline-test', status: 'unverified', input: '$0', output: '$3', cacheRead: 'n/a',
      });

      // Mutation controls for claude table output: wrong status, missing status, wrong price
      assert.throws(() => assertModelTableRow(output, {
        model: 'claude-offline-test', status: 'valid', input: '$0', output: '$3', cacheRead: 'n/a',
      }), /table row for claude-offline-test/);
      assert.throws(() => assertModelTableRow(output, {
        model: 'claude-offline-test', status: 'old', input: '$0', output: '$3', cacheRead: 'n/a',
      }), /table row for claude-offline-test/);
      assert.throws(() => assertModelTableRow(output.replace(/\bSTATUS\s+/, ''), {
        model: 'claude-offline-test', status: 'unverified', input: '$0', output: '$3', cacheRead: 'n/a',
      }), /table header must include STATUS column/);
      assert.throws(() => assertModelTableRow(output.replace('unverified     ', ''), {
        model: 'claude-offline-test', status: 'unverified', input: '$0', output: '$3', cacheRead: 'n/a',
      }), /table row for claude-offline-test/);
      assert.throws(() => assertModelTableRow(output, {
        model: 'claude-offline-test', status: 'unverified', input: '$99', output: '$3', cacheRead: 'n/a',
      }), /table row for claude-offline-test/);
      assert.throws(() => assertModelTableRow(output, {
        model: 'claude-offline-test', status: 'unverified', input: '$0', output: '$99', cacheRead: 'n/a',
      }), /table row for claude-offline-test/);
    } finally {
      if (priorPin === undefined) delete env.LMCTL_PRICE_DATA;
      else env.LMCTL_PRICE_DATA = priorPin;
    }
  });

  check('partial input refuses missing answers and force bypasses without a terminal', () => {
    for (const argv of [
      ["lmctl", join(root, 'absent.lmc')],
      ["lmctl", join(root, 'partial.lmc'), '--force'],
      ["lmctl", 'prompt', 'partial.lmc:Lead'],
      ["lmctl", 'prompt', 'partial.lmc', 'Lead'],
    ]) {
      assert.throws(() => run(argv), (error) => {
        assert.equal(error.status, 2);
        if (argv[1] === 'prompt') {
          assert.match(String(error.stderr), /prompt text is required/);
          assert.doesNotMatch(String(error.stderr), /lmctl chat/);
        }
        return true;
      });
    }
  });

  check('ls lists no runs in an empty isolated database', () => {
    assert.deepEqual(JSON.parse(run(["lmctl", "ls", '--runs', '--json'])), []);
  });

  check('running reports no activity in an empty isolated database and no longer offers --json-legacy', () => {
    // Default `running --json` is the stable sessions schema: {generated_at, sessions}.
    const result = JSON.parse(run(["lmctl", "running", '--json']));
    assert.equal(typeof result.generated_at, 'string');
    assert.ok(!Number.isNaN(Date.parse(result.generated_at)), 'generated_at must be an ISO timestamp');
    assert.deepEqual(result.sessions, []);
    // The default document is exactly {generated_at, sessions}: no legacy running/dead/idle arrays, schema_version or error rows.
    assert.deepEqual(Object.keys(result).sort(), ['generated_at', 'sessions']);
    // The old running/dead/idle report (--json-legacy) was removed once the liveness readers moved to the stable
    // sessions JSON: the flag is now an unknown flag, alone or combined with --json, and prints no document.
    for (const args of [["lmctl", "running", '--json-legacy'], ["lmctl", "running", '--json', '--json-legacy']]) {
      assert.throws(
        () => run(args),
        (error) => error.status !== 0 && /unknown flag: --json-legacy/.test(`${error.stderr}`) && `${error.stdout}` === '',
        `${args.join(' ')} must be refused`,
      );
    }
  });

  check('db backfills an empty isolated database idempotently', () => {
    for (let i = 0; i < 2; i += 1) {
      const result = JSON.parse(run(["lmctl", "db", 'backfill-events']));
      assert.equal(result.appended, 0);
      assert.equal(result.projections.invocation_state, 0);
    }
  });

  // `usage` and `prices` arrived after the first coverage baseline. Executing assertions (not just --help), offline,
  // against the isolated empty state. They run only when the installed lmctl has the command, so the suite still
  // passes against an older release.
  const helpText = run(["lmctl", "--help"]);
  const has = (name) => new RegExp(`^  ${name} {2,}`, 'm').test(helpText);
  const runResult = (argv, options = {}) => {
    assert.equal(argv[0], 'lmctl');
    const result = spawnSync(bin, argv.slice(1), {
      cwd: options.cwd ?? root,
      env: { ...env, ...options.env },
      encoding: 'utf8',
      timeout: 60000,
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
  const failure = (argv, options = {}) => {
    const res = runResult(argv, options);
    return { status: res.status, stderr: res.stderr, stdout: res.stdout };
  };

  if (has('usage')) {
    check('usage --json reports an empty, well-formed window on a fresh database', () => {
      const result = JSON.parse(run(["lmctl", "usage", "--json"]));
      assert.equal(result.schema_version, 1);
      assert.equal(result.by, 'day');
      assert.deepEqual(result.groups, []);
      assert.equal(result.total.turns, 0);
      assert.ok(Date.parse(result.since) < Date.parse(result.until), 'window must start before it ends');
    });
    check('usage prints a readable empty report', () => {
      const output = run(["lmctl", "usage"]);
      assert.match(output, /no usage recorded yet/);
      assert.match(output, /Period \(UTC\)/);
    });
    check('usage rejects an unknown --by with exit 2 and a clear message', () => {
      const result = failure(["lmctl", "usage", "--by", "nonsense"]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /invalid --by: nonsense/);
    });
  }

  if (has('prices')) {
    check('prices show reports "unavailable", not a crash, when no price snapshot is stored', () => {
      assert.match(run(["lmctl", "prices", "show"]), /^unavailable: /m);
      const result = JSON.parse(run(["lmctl", "prices", "show", "--json"]));
      assert.equal(result.schema_version, 1);
      assert.equal(result.status, 'unavailable');
      assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    });
    check('prices update refuses an invalid snapshot and says what is required', () => {
      writeFileSync(join(root, 'bad-catalog.json'), '{"x":1}\n');
      writeFileSync(join(root, 'aliases.json'), '{}\n');
      const result = failure(["lmctl", "prices", "update", join(root, 'bad-catalog.json')]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /invalid or incomplete price snapshot/);
    });
  }

  if (has('whoami')) {
    check('whoami without an appkey exits 3 with the login hint, as text and as a JSON error', () => {
      const text = runResult(["lmctl", "whoami"]);
      assert.equal(text.status, 3);
      assert.match(`${text.stdout}${text.stderr}`, /no lmctl appkey found; run `lmchat login`/);
      const json = runResult(["lmctl", "whoami", "--json"]);
      assert.equal(json.status, 3);
      const parsed = JSON.parse(json.stdout);
      assert.equal(parsed.error.code, 'no_appkey');
      assert.match(parsed.error.message, /no lmctl appkey found/);
      // Mutation controls: a wrong exit status, a wrong error code and a missing hint must all fail the assertions.
      assert.throws(() => assert.equal(0, text.status));
      assert.throws(() => assert.equal(parsed.error.code, 'unauthorized'));
      assert.throws(() => assert.match('user_id: someone', /no lmctl appkey found/));
    });
  }

  if (has('site')) {
    check('site status, enable and disable round-trip through site.json without a network or appkey', () => {
      const siteJson = join(env.HOME, '.lmctl', 'site.json');
      const disabledBefore = runResult(["lmctl", "site", "status"]);
      assert.equal(disabledBefore.status, 0);
      assert.match(disabledBefore.stdout, /^disabled \(lmctl site enable --name NAME/);
      assert.equal(existsSync(siteJson), false);

      const enabled = runResult(["lmctl", "site", "enable", "--name", "box1", "--allow-tracked", "--interval", "90"]);
      assert.equal(enabled.status, 0, enabled.stderr);
      assert.match(enabled.stdout, /^site box1 enabled in .*site\.json; the lmctl daemon runs it from its next start/);
      assert.deepEqual(JSON.parse(readFileSync(siteJson, 'utf8')), { name: 'box1', allow: [], allowTracked: true, interval: 90 });
      const enabledStatus = runResult(["lmctl", "site", "status"]);
      assert.equal(enabledStatus.status, 0);
      assert.match(enabledStatus.stdout, /^enabled: site box1, allow every tracked session, every 90 s \(runs inside lmctl serve daemon\)/);

      const disabled = runResult(["lmctl", "site", "disable"]);
      assert.equal(disabled.status, 0);
      assert.match(disabled.stdout, /^site agent disabled \(.*site\.json removed\); it stops when the lmctl daemon restarts/);
      assert.equal(existsSync(siteJson), false);
      assert.match(runResult(["lmctl", "site", "status"]).stdout, /^disabled \(/);

      // Mutation controls: the enabled status must not satisfy the disabled pattern, and a wrong exit status fails.
      assert.throws(() => assert.match(enabledStatus.stdout, /^disabled \(/));
      assert.throws(() => assert.equal(enabledStatus.status, 1));
      assert.throws(() => assert.equal(existsSync(siteJson), true));
    });
    check('site list without an appkey and an unknown site subcommand both exit 1 with a clear message', () => {
      const list = runResult(["lmctl", "site", "list"]);
      assert.equal(list.status, 1);
      assert.match(list.stderr, /^error: lmctl site: no appkey found/m);
      const bogus = runResult(["lmctl", "site", "bogus"]);
      assert.equal(bogus.status, 1);
      assert.match(bogus.stderr, /^error: lmctl site: unknown subcommand bogus/m);
      assert.match(bogus.stderr, /usage: lmctl site serve --name NAME/);
      // Mutation controls: the two refusals are distinct, and a success status must not pass.
      assert.throws(() => assert.match(list.stderr, /unknown subcommand/));
      assert.throws(() => assert.match(bogus.stderr, /no appkey found/));
      assert.throws(() => assert.equal(bogus.status, 0));
    });
  }

  if (has('autorun')) {
    check('autorun executes a local script and forwards arguments', () => {
      const script = join(root, 'autorun-local.lms');
      writeFileSync(script, 'println("AUTORUN_ARG0:" + args[0]);\nprintln("AUTORUN_ARG1:" + args[1]);\n');
      const result = runResult(["lmctl", "autorun", script, "--json", "value with spaces"]);
      assert.equal(result.status, 0);
      assert.match(result.stderr, new RegExp(`^Running ${script.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`, 'm'));
      assert.match(result.stdout, /AUTORUN_ARG0:--json\nAUTORUN_ARG1:value with spaces\n/);

      // Mutation controls: nonzero exit status, missing Running on stderr, dropped spaced arg
      assert.throws(() => {
        const mutatedStatus = 1;
        assert.equal(mutatedStatus, 0);
      });
      assert.throws(() => {
        assert.match('Running other-path.lms', new RegExp(`^Running ${script.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`, 'm'));
      });
      assert.throws(() => {
        const mutatedStdout = 'AUTORUN_ARG0:--json\nAUTORUN_ARG1:value-without-spaces\n';
        assert.match(mutatedStdout, /AUTORUN_ARG0:--json\nAUTORUN_ARG1:value with spaces\n/);
      });
    });

    check('autorun reports a missing local script with exit failure', () => {
      const missingScript = join(root, 'missing-autorun.lms');
      const result = failure(["lmctl", "autorun", missingScript]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /could not fetch|ENOENT/i);

      // Mutation controls: zero exit status, missing ENOENT message
      assert.throws(() => {
        const mutatedStatus = 0;
        assert.notEqual(mutatedStatus, 0);
      });
      assert.throws(() => {
        assert.match('everything okay', /could not fetch|ENOENT/i);
      });
    });

    check('autorun --save-only writes a mapped script for unavailable provider role without execution', () => {
      const roleScript = join(root, 'role_unavailable.lms');
      const sideEffectMarker = join(root, 'role_unavailable.side_effect');
      const executionToken = 'ROLE_UNAVAILABLE_OBSERVABLE_EXECUTION_TOKEN_3b8a1';
      if (existsSync(sideEffectMarker)) rmSync(sideEffectMarker);

      writeFileSync(roleScript, [
        '// autorun-role: Lead provider=uninstalled model=some-model',
        `write_file(${JSON.stringify(sideEffectMarker)}, "executed");`,
        `println(${JSON.stringify(executionToken)});`,
        'println("ROLE_PROVIDER:" + "@role(Lead.provider)");',
        'println("ROLE_MODEL:" + "@role(Lead.model)");',
      ].join('\n') + '\n');
      const mappedDest = join(root, 'role_unavailable2.lms');
      if (existsSync(mappedDest)) rmSync(mappedDest);

      const result = runResult(["lmctl", "autorun", "--save-only", roleScript]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Suggested provider\/model substitutions:/);
      assert.match(result.stdout, new RegExp(`Saved mapped script: ${mappedDest.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`));
      assert.doesNotMatch(result.stderr, /^Running /m, 'autorun --save-only must not report Running');
      assert.doesNotMatch(result.stdout, new RegExp(executionToken), 'autorun --save-only must not execute script or print execution token');
      assert.ok(!existsSync(sideEffectMarker), 'autorun --save-only must not execute script or create side effect marker');
      assert.ok(existsSync(mappedDest), 'mapped script destination file must exist');

      const mappedContent = readFileSync(mappedDest, 'utf8');
      assert.match(mappedContent, /^\/\/ autorun-role: Lead provider=(?:claude|codex|agy) model=/m);
      assert.doesNotMatch(mappedContent, /@role\(/, 'all role placeholders must be rewritten');

      // Normal run of the mapped script must execute and produce both the side effect marker and token
      const normalRun = runResult(["lmctl", "script", mappedDest]);
      assert.equal(normalRun.status, 0);
      assert.match(normalRun.stdout, new RegExp(executionToken), 'normal run of mapped script must print execution token');
      assert.ok(existsSync(sideEffectMarker), 'normal run of mapped script must create side effect marker file');
      assert.equal(readFileSync(sideEffectMarker, 'utf8'), 'executed');

      // Mutation controls:
      // 1. Script execution detected during save-only (stderr Running)
      assert.throws(() => {
        const mutatedStderr = `Running ${roleScript}\n`;
        assert.doesNotMatch(mutatedStderr, /^Running /m);
      });
      // 2. Script execution detected during save-only (token printed to stdout)
      assert.throws(() => {
        const mutatedStdout = result.stdout + `\n${executionToken}\nROLE_PROVIDER:claude\n`;
        assert.doesNotMatch(mutatedStdout, new RegExp(executionToken));
      });
      // 3. Script execution detected during save-only (side effect marker created)
      assert.throws(() => {
        const mutatedMarkerExists = true;
        assert.ok(!mutatedMarkerExists, 'autorun --save-only must not execute script or create side effect marker');
      });
      // 4. Mapping destination file missing
      assert.throws(() => {
        const fileCreated = false;
        assert.ok(fileCreated, 'mapped script destination file must exist');
      });
      // 5. Unrewritten role placeholders in mapped script
      assert.throws(() => {
        const badContent = mappedContent + '\nprintln(@role(Lead.provider));';
        assert.doesNotMatch(badContent, /@role\(/);
      });
      // 6. Normal run fails to produce execution token
      assert.throws(() => {
        const mutatedNormalStdout = 'TOKEN_MISMATCH';
        assert.match(mutatedNormalStdout, new RegExp(executionToken));
      });
      // 7. Normal run fails to create side effect marker
      assert.throws(() => {
        const markerPresent = false;
        assert.ok(markerPresent, 'normal run of mapped script must create side effect marker file');
      });
    });

    check('autorun executes directly without mapping when declared role provider is on PATH', () => {
      const rolePresentScript = join(root, 'role_present.lms');
      writeFileSync(rolePresentScript, [
        '// autorun-role: Lead provider=codex model=gpt-6-luna',
        'println("PRESENT_PROVIDER:" + "@role(Lead.provider)");',
        'println("PRESENT_MODEL:" + "@role(Lead.model)");',
      ].join('\n') + '\n');
      const mappedPresentDest = join(root, 'role_present2.lms');
      if (existsSync(mappedPresentDest)) rmSync(mappedPresentDest);

      const result = runResult(["lmctl", "autorun", rolePresentScript]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /PRESENT_PROVIDER:codex\nPRESENT_MODEL:gpt-6-luna\n/);
      assert.match(result.stderr, new RegExp(`^Running ${rolePresentScript.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`, 'm'));
      assert.ok(!existsSync(mappedPresentDest), 'no mapping file should be created when provider is present on PATH');

      // Mutation controls: mapping file unexpectedly created, provider output wrong
      assert.throws(() => {
        const mappingCreated = true;
        assert.ok(!mappingCreated, 'no mapping file should be created when provider is present on PATH');
      });
      assert.throws(() => {
        const mutatedStdout = 'PRESENT_PROVIDER:other\nPRESENT_MODEL:gpt-6-luna\n';
        assert.match(mutatedStdout, /PRESENT_PROVIDER:codex\nPRESENT_MODEL:gpt-6-luna\n/);
      });
    });
  }

  if (has('quickrun')) {
    const probe = await probeNetworkReachable('lmctl.com', 443, 800);
    if (!probe.reachable) {
      skip('hosted catalog', `network unreachable (${probe.reason})`);
    } else {
      check('quickrun lists hosted catalog samples without arguments', () => {
        const result = runResult(["lmctl", "quickrun"]);
        assert.equal(result.status, 0);
        assert.match(result.stderr, /^quickrun is deprecated; use lmctl autorun for curated examples\.\n/);
        assert.match(result.stdout, /^solo\s/m);
        assert.match(result.stdout, /^review\s/m);

        // Mutation controls: missing deprecation notice
        assert.throws(() => {
          const mutatedStderr = result.stderr.replace('quickrun is deprecated', 'deprecated');
          assert.match(mutatedStderr, /^quickrun is deprecated; use lmctl autorun for curated examples\.\n/);
        });
      });
    }
    check('quickrun executes a local script and forwards arguments', () => {
      const script = join(root, 'qr-local.lms');
      writeFileSync(script, 'println("QR_ARG:" + args[0]);\n');
      const result = runResult(["lmctl", "quickrun", script, "test-val"]);
      assert.equal(result.status, 0);
      assert.match(result.stderr, /^quickrun is deprecated; use lmctl autorun for curated examples\.\n/);
      assert.match(result.stdout, /QR_ARG:test-val/);

      // Mutation controls: missing deprecation notice, arguments not forwarded
      assert.throws(() => {
        const mutatedStderr = result.stderr.replace('quickrun is deprecated', 'deprecated');
        assert.match(mutatedStderr, /^quickrun is deprecated; use lmctl autorun for curated examples\.\n/);
      });
      assert.throws(() => {
        const mutatedStdout = 'QR_ARG:wrong-val';
        assert.match(mutatedStdout, /QR_ARG:test-val/);
      });
    });
    check('quickrun reports a missing local script with exit failure', () => {
      const result = failure(["lmctl", "quickrun", join(root, 'missing-sample.lms')]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /^quickrun is deprecated; use lmctl autorun for curated examples\.\n/);
      assert.match(result.stderr, /could not fetch|ENOENT/i);

      // Mutation controls: exit status 0, missing deprecation notice, wrong error pattern
      assert.throws(() => {
        const mutatedStatus = 0;
        assert.notEqual(mutatedStatus, 0);
      });
      assert.throws(() => {
        const mutatedStderr = result.stderr.replace('quickrun is deprecated', 'deprecated');
        assert.match(mutatedStderr, /^quickrun is deprecated; use lmctl autorun for curated examples\.\n/);
      });
      assert.throws(() => {
        assert.match('error: unexpected problem', /could not fetch|ENOENT/i);
      });
    });
  }

  if (has('hello')) {
    // Note: hello is exercised only with --help to verify its entry point and deprecation notice offline.
    // Hosted script forwarding (https://lmctl.com/helloexample/hello.lms) requires network and is unverified here to stay hermetic.
    check('hello deprecated alias prints deprecation notice and displays help', () => {
      const result = runResult(["lmctl", "hello", "--help"]);
      assert.equal(result.status, 0);
      assert.match(result.stderr, /^hello is deprecated; use lmctl autorun https:\/\/lmctl\.com\/helloexample\/hello\.lms instead\.\n/);
      assert.match(result.stdout, /usage: lmctl hello/);

      // Mutation controls: wrong exit status, missing deprecation notice, missing usage
      assert.throws(() => {
        const mutatedStatus = 1;
        assert.equal(mutatedStatus, 0);
      });
      assert.throws(() => {
        const mutatedStderr = result.stderr.replace('hello is deprecated', 'deprecated');
        assert.match(mutatedStderr, /^hello is deprecated; use lmctl autorun https:\/\/lmctl\.com\/helloexample\/hello\.lms instead\.\n/);
      });
      assert.throws(() => {
        assert.match('usage: other command', /usage: lmctl hello/);
      });
    });
  }

  // The package ships two binaries (lmctl, lmscript). Fixtures are provisioned by lmctl itself: a writable open of an empty database
  // file (`lmctl running`, which lists in-flight dispatches and records no team, no state and no queue row) creates the full schema,
  // so the empty database stays genuinely empty; `lmctl seed` registers a team without any provider call.
  const lmctlTestDir = join(root, 'native-isolated');
  mkdirSync(lmctlTestDir, { recursive: true });

  const emptyDb = join(lmctlTestDir, 'empty-state.db');
  writeFileSync(emptyDb, '');
  const emptyHome = join(lmctlTestDir, 'empty-home');
  mkdirSync(emptyHome, { recursive: true });
  const emptyDbEnv = {
    ...env,
    HOME: emptyHome,
    LMCTL_DB: emptyDb,
  };

  const seededDb = join(lmctlTestDir, 'seeded-state.db');
  writeFileSync(seededDb, '');
  const seededHome = join(lmctlTestDir, 'seeded-home');
  mkdirSync(seededHome, { recursive: true });
  let seededLmctlTeamPath = '';
  const seededDbEnv = {
    ...env,
    HOME: seededHome,
    LMCTL_DB: seededDb,
  };

  if (has('attention') || has('in-flight') || has('stalled') || has('history') || has('teams')) {
    const tableNames = (dbPath) => {
      const handle = new DatabaseSync(dbPath);
      try {
        return new Set(handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      } finally {
        handle.close();
      }
    };
    for (const [label, dbEnv, dbPath] of [['emptyDb', emptyDbEnv, emptyDb], ['seededDb', seededDbEnv, seededDb]]) {
      assert.equal(tableNames(dbPath).size, 0, `${label} must start as an empty file`);
      const prov = spawnSync(bin, ['running'], { cwd: lmctlTestDir, env: dbEnv, encoding: 'utf8' });
      assert.equal(prov.status, 0, `lmctl running failed for ${label}: ${prov.stderr || prov.stdout}`);
      assert.ok(tableNames(dbPath).has('durable_memory'), `lmctl running did not provision the full schema for ${label}`);
    }

    // `lmctl teams` and `lmctl history` are native read views over lmctl's own tables (root_team, team_chat_log); they
    // no longer read any lmbee team registry or events table (lmbee is not part of the package). Register a team the lmctl way
    // (a teamfile whose member already has a sessionid is registered by `lmctl seed` without any provider call) and record one chat turn.
    seededLmctlTeamPath = join(lmctlTestDir, 'beta.lmctl');
    writeFileSync(seededLmctlTeamPath, '_TEAM_ name=beta\n_MEMBER_ alias=Lead provider=codex model=gpt-6-luna sessionid=22222222-2222-4222-8222-222222222222\n');
    const seedRes = spawnSync(bin, ['seed', seededLmctlTeamPath], { cwd: lmctlTestDir, env: seededDbEnv, encoding: 'utf8' });
    assert.equal(seedRes.status, 0, `lmctl seed failed for beta: ${seedRes.stderr || seedRes.stdout}`);
    const dbSync = new DatabaseSync(seededDb);
    dbSync.prepare(
      "INSERT INTO team_chat_log(root_teamfile, sender_teamfile, sender_alias, receiver_teamfile, receiver_alias, message, response, origin, status, created_at) VALUES (?, ?, 'Lead', ?, 'Lead', 'seeded history message', 'seeded history reply', 'operator', 'DONE', '2026-10-23T12:00:00.000Z')",
    ).run(seededLmctlTeamPath, seededLmctlTeamPath, seededLmctlTeamPath);
    dbSync.close();
  }

  if (has('attention')) {
    // `attention` was lmbee's automatic-nudging report; the owner disabled automatic nudging (DECISION-lmbee-removal-scope, ruling 2)
    // and the shipped command is a clear, non-zero refusal that points at `lmctl running` and `lmctl history`. (It is still listed in
    // `lmctl --help`; that is reported to the product team as a finding, not asserted here.)
    check('attention is retired with automatic nudging: exits 1 with the replacement hint and prints nothing on stdout', () => {
      for (const args of [["lmctl", "attention"], ["lmctl", "attention", "--json"]]) {
        for (const dbEnv of [emptyDbEnv, seededDbEnv]) {
          const res = runResult(args, { env: dbEnv });
          assert.equal(res.status, 1, `${args.join(' ')} must exit 1`);
          assert.equal(res.stdout.trim(), '');
          assert.match(res.stderr, /attention is retired with lmbee automatic-nudging; use lmctl running and lmctl history/);
        }
      }
      // Mutation controls: a success exit, output on stdout, or a different message must not satisfy the assertions
      assert.throws(() => assert.equal(0, 1));
      assert.throws(() => assert.equal('all clear -- nothing needs attention'.trim(), ''));
      assert.throws(() => assert.match('error: unknown command: attention', /attention is retired with lmbee automatic-nudging/));
    });
  }

  if (has('in-flight')) {
    check('in-flight is the stable running-sessions view (`running --state running --json`), on empty and seeded databases', () => {
      // The former lmbee in-flight report (text verdict, inFlight/lctlRunning/otherTeamsRunning JSON) was replaced
      // by the stable `lmctl running --json` sessions schema: {generated_at, sessions}. Output is JSON in both modes.
      for (const [label, dbEnv] of [['empty', emptyDbEnv], ['seeded', seededDbEnv]]) {
        for (const args of [["lmctl", "in-flight"], ["lmctl", "in-flight", "--json"]]) {
          const res = runResult(args, { env: dbEnv });
          assert.equal(res.status, 0, `${args.join(' ')} on ${label} database: ${res.stderr}`);
          const doc = JSON.parse(res.stdout);
          assert.deepEqual(Object.keys(doc).sort(), ['generated_at', 'sessions']);
          assert.ok(!Number.isNaN(Date.parse(doc.generated_at)), 'generated_at must be an ISO timestamp');
          // Nothing is dispatching in an isolated database, so the registered (idle) team has no running session.
          assert.deepEqual(doc.sessions, []);
        }
        // It is the same document `lmctl running --state running --json` produces.
        const viaRunningRes = runResult(["lmctl", "running", "--state", "running", "--json"], { env: dbEnv });
        assert.equal(viaRunningRes.status, 0, viaRunningRes.stderr);
        assert.equal(viaRunningRes.stderr, '');
        const viaRunning = JSON.parse(viaRunningRes.stdout);
        assert.deepEqual(Object.keys(viaRunning).sort(), ['generated_at', 'sessions']);
        assert.deepEqual(viaRunning.sessions, []);
      }
      // Populated case: one genuinely running tracked invocation (its holder is a live process on this host), one finished OK
      // and one finished with an error. `in-flight` must list exactly the running one and equal `running --state running --json`;
      // an implementation that always answers with empty sessions fails here.
      const activeDb = join(lmctlTestDir, 'active-state.db');
      writeFileSync(activeDb, '');
      const activeEnv = { ...env, HOME: join(lmctlTestDir, 'active-home'), LMCTL_DB: activeDb };
      mkdirSync(activeEnv.HOME, { recursive: true });
      const provisioned = spawnSync(bin, ['running'], { cwd: lmctlTestDir, env: activeEnv, encoding: 'utf8' });
      assert.equal(provisioned.status, 0, provisioned.stderr);
      const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
      try {
        assert.ok(Number.isInteger(holder.pid), 'the holder process must start');
        const stamp = new Date().toISOString();
        const handle = new DatabaseSync(activeDb);
        try {
          const insert = handle.prepare(`INSERT INTO tracked_invocation(kind, origin, from_identity, target_teamfile, target_alias, status, started_at, ended_at, holder_pid, holder_host, last_heartbeat_at, error, launch_source)
            VALUES (?, 'operator', 'operator', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          insert.run('chat', '/teams/alpha.lmctl', 'Coder', 'running', stamp, null, holder.pid, hostname(), stamp, null, 'chat');
          insert.run('exec', '/teams/gamma.lmctl', 'Reviewer', 'done', stamp, stamp, null, null, null, null, 'exec');
          insert.run('chat', '/teams/delta.lmctl', 'Coder', 'error', stamp, stamp, null, null, null, 'fixture failure', 'chat');
        } finally {
          handle.close();
        }
        const inFlightRes = runResult(["lmctl", "in-flight"], { env: activeEnv });
        assert.equal(inFlightRes.status, 0, inFlightRes.stderr);
        assert.equal(inFlightRes.stderr, '');
        const inFlight = JSON.parse(inFlightRes.stdout);
        assert.deepEqual(Object.keys(inFlight).sort(), ['generated_at', 'sessions']);
        assert.equal(inFlight.sessions.length, 1, `in-flight must list the one running session: ${inFlightRes.stdout}`);
        const [active] = inFlight.sessions;
        assert.equal(active.id, '/teams/alpha.lmctl#Coder');
        assert.equal(active.team, 'alpha');
        assert.equal(active.member, 'Coder');
        assert.equal(active.kind, 'chat');
        assert.equal(active.state, 'running');
        assert.equal(active.liveness, 'live');
        assert.equal(active.busy, true);
        assert.equal(active.can_prompt, false);
        // Equal to the reference view (only generated_at differs), and the same through `--json`.
        const refRes = runResult(["lmctl", "running", "--state", "running", "--json"], { env: activeEnv });
        assert.equal(refRes.status, 0, refRes.stderr);
        assert.equal(refRes.stderr, '');
        assert.deepEqual(inFlight.sessions, JSON.parse(refRes.stdout).sessions);
        const inFlightJsonRes = runResult(["lmctl", "in-flight", "--json"], { env: activeEnv });
        assert.equal(inFlightJsonRes.status, 0, inFlightJsonRes.stderr);
        assert.deepEqual(JSON.parse(inFlightJsonRes.stdout).sessions, inFlight.sessions);
        // Finished sessions are not in flight, yet the fixture is real: the unfiltered view does list them.
        const allRes = runResult(["lmctl", "running", "--json"], { env: activeEnv });
        assert.equal(allRes.status, 0, allRes.stderr);
        const all = JSON.parse(allRes.stdout).sessions;
        assert.deepEqual(all.map((session) => `${session.id}:${session.state}`).sort(), [
          '/teams/alpha.lmctl#Coder:running', '/teams/delta.lmctl#Coder:error', '/teams/gamma.lmctl#Reviewer:done',
        ]);
        assert.ok(!inFlight.sessions.some((session) => session.state !== 'running'));
        // Mutation controls: an always-empty answer, a finished session listed, or a changed identity must not satisfy the checks
        assert.throws(() => assert.equal([].length, 1));
        assert.throws(() => assert.deepEqual([], JSON.parse(refRes.stdout).sessions));
        assert.throws(() => assert.deepEqual(all, JSON.parse(refRes.stdout).sessions));
        assert.throws(() => assert.equal(active.id.replace('alpha', 'beta'), '/teams/alpha.lmctl#Coder'));
      } finally {
        holder.kill('SIGKILL');
      }
      // The retired lmbee report fields are gone.
      const retired = JSON.parse(runResult(["lmctl", "in-flight", "--json"], { env: emptyDbEnv }).stdout);
      for (const key of ['inFlight', 'lctlRunning', 'otherTeamsRunning']) assert.equal(retired[key], undefined, `${key} is retired`);

      // Mutation controls: exit status non-zero, wrong keys, wrong sessions type, retired field present
      assert.throws(() => {
        const mutatedStatus = 1;
        assert.equal(mutatedStatus, 0);
      });
      assert.throws(() => {
        assert.deepEqual(Object.keys({ inFlight: false, lctlRunning: {}, otherTeamsRunning: [] }).sort(), ['generated_at', 'sessions']);
      });
      assert.throws(() => {
        assert.deepEqual(['not-empty'], []);
      });
      assert.throws(() => {
        assert.equal({ inFlight: false }.inFlight, undefined);
      });
    });
  }

  // `stalled` is retired together with automatic nudging. It is no longer listed in `lmctl --help` (so it is not
  // gated on `has`): the command must stay a clear, non-zero refusal that points at `lmctl running`, in every mode.
  check('stalled is retired: exits 1 with the replacement hint and prints nothing on stdout', () => {
    assert.ok(!has('stalled'), 'stalled must not be advertised in lmctl --help');
    for (const args of [["lmctl", "stalled"], ["lmctl", "stalled", "--json"]]) {
      const res = runResult(args, { env: emptyDbEnv });
      assert.equal(res.status, 1, `${args.join(' ')} must exit 1`);
      assert.equal(res.stdout.trim(), '');
      assert.match(res.stderr, /stalled is retired with automatic nudging; use lmctl running --state running\|error/);
    }
    // Mutation controls: a success exit, output on stdout, or a different message must not satisfy the assertions
    assert.throws(() => {
      const mutatedStatus = 0;
      assert.equal(mutatedStatus, 1);
    });
    assert.throws(() => {
      assert.equal('alpha\ttrue'.trim(), '');
    });
    assert.throws(() => {
      assert.match('error: unknown command', /stalled is retired with automatic nudging/);
    });
  });

  if (has('history')) {
    check('history is a native read view of team_chat_log: empty database prints nothing, seeded turn is listed', () => {
      // Empty database: no table header any more, just no rows
      const emptyResult = runResult(["lmctl", "history"], { env: emptyDbEnv });
      assert.equal(emptyResult.status, 0);
      assert.equal(emptyResult.stdout, '');

      const emptyJsonRes = runResult(["lmctl", "history", "--json"], { env: emptyDbEnv });
      assert.equal(emptyJsonRes.status, 0);
      const emptyJson = JSON.parse(emptyJsonRes.stdout);
      assert.deepEqual(emptyJson, { events: [] });

      // Seeded database: one recorded chat turn, text is "<ts>  <team>  <status>"
      const seededResult = runResult(["lmctl", "history"], { env: seededDbEnv });
      assert.equal(seededResult.status, 0);
      assert.equal(seededResult.stdout, `2026-10-23T12:00:00.000Z  ${seededLmctlTeamPath}  DONE\n`);

      const seededJsonRes = runResult(["lmctl", "history", "--json"], { env: seededDbEnv });
      assert.equal(seededJsonRes.status, 0);
      const seededJson = JSON.parse(seededJsonRes.stdout);
      assert.ok(Array.isArray(seededJson.events));
      assert.equal(seededJson.events.length, 1);
      const event = seededJson.events[0];
      assert.equal(event.team, seededLmctlTeamPath);
      assert.equal(event.status, 'DONE');
      assert.equal(event.ts, '2026-10-23T12:00:00.000Z');
      assert.equal(event.sender_alias, 'Lead');
      assert.equal(event.receiver_alias, 'Lead');
      assert.equal(event.message, 'seeded history message');
      assert.equal(event.response, 'seeded history reply');

      // The team filter applies; both filtered calls must succeed silently (a failing command may not certify the JSON)
      const filteredRes = runResult(["lmctl", "history", seededLmctlTeamPath, "--json"], { env: seededDbEnv });
      assert.equal(filteredRes.status, 0, filteredRes.stderr);
      assert.equal(filteredRes.stderr, '');
      assert.equal(JSON.parse(filteredRes.stdout).events.length, 1);
      const otherTeamRes = runResult(["lmctl", "history", join(lmctlTestDir, 'nobody.lmctl'), "--json"], { env: seededDbEnv });
      assert.equal(otherTeamRes.status, 0, otherTeamRes.stderr);
      assert.equal(otherTeamRes.stderr, '');
      assert.deepEqual(JSON.parse(otherTeamRes.stdout), { events: [] });

      // Mutation controls: exit status non-zero, json status non-zero, rows on the empty database, missing event row
      assert.throws(() => {
        const mutatedStatus = 1;
        assert.equal(mutatedStatus, 0);
      });
      assert.throws(() => {
        const mutatedJsonStatus = 42;
        assert.equal(mutatedJsonStatus, 0);
      });
      assert.throws(() => {
        assert.equal(seededResult.stdout, '');
      });
      assert.throws(() => {
        const mutatedStdout = seededResult.stdout.replace('DONE', 'FAILED');
        assert.equal(mutatedStdout, `2026-10-23T12:00:00.000Z  ${seededLmctlTeamPath}  DONE\n`);
      });
      assert.throws(() => {
        const mutatedEvents = [];
        assert.equal(mutatedEvents.length, 1);
      });
    });
  }

  if (has('teams')) {
    check('teams is a native read view of the lmctl team registry: empty database prints nothing, registered team is listed', () => {
      // Empty database: no table header any more, just no rows
      const emptyResult = runResult(["lmctl", "teams"], { env: emptyDbEnv });
      assert.equal(emptyResult.status, 0);
      assert.equal(emptyResult.stdout, '');

      const emptyJsonRes = runResult(["lmctl", "teams", "--json"], { env: emptyDbEnv });
      assert.equal(emptyJsonRes.status, 0);
      const emptyJson = JSON.parse(emptyJsonRes.stdout);
      assert.deepEqual(emptyJson, { teams: [] });

      // Seeded database: beta was registered by `lmctl seed`
      const seededResult = runResult(["lmctl", "teams"], { env: seededDbEnv });
      assert.equal(seededResult.status, 0);
      assert.equal(seededResult.stdout, `beta  ${seededLmctlTeamPath}\n`);

      const seededJsonRes = runResult(["lmctl", "teams", "--json"], { env: seededDbEnv });
      assert.equal(seededJsonRes.status, 0);
      const seededJson = JSON.parse(seededJsonRes.stdout);
      assert.ok(Array.isArray(seededJson.teams));
      assert.equal(seededJson.teams.length, 1);
      assert.equal(seededJson.teams[0].name, 'beta');
      assert.equal(seededJson.teams[0].team, 'beta');
      assert.equal(seededJson.teams[0].path, seededLmctlTeamPath);
      assert.equal(seededJson.teams[0].channel, 'local');

      // Mutation controls: exit status non-zero, json status non-zero, rows on the empty database, missing seeded team
      assert.throws(() => {
        const mutatedStatus = 1;
        assert.equal(mutatedStatus, 0);
      });
      assert.throws(() => {
        const mutatedJsonStatus = 42;
        assert.equal(mutatedJsonStatus, 0);
      });
      assert.throws(() => {
        assert.equal(seededResult.stdout, '');
      });
      assert.throws(() => {
        const mutatedStdout = seededResult.stdout.replace('beta', 'other');
        assert.equal(mutatedStdout, `beta  ${seededLmctlTeamPath}\n`);
      });
      assert.throws(() => {
        const mutatedTeams = [];
        assert.equal(mutatedTeams.length, 1);
      });
    });
  }

  if (has('reliability-report')) {
    check('reliability-report exits code 2 with unavailable message without altering or creating the database', () => {
      const absentDb = join(lmctlTestDir, 'absent-reliability.db');
      if (existsSync(absentDb)) rmSync(absentDb);
      const absentEnv = { ...env, LMCTL_DB: absentDb };

      // 1. Run against absent database: assert it exits 2, exact error message, and does not create the file
      const absentResult = failure(["lmctl", "reliability-report"], { env: absentEnv });
      assert.equal(absentResult.status, 2);
      assert.match(absentResult.stderr, /^error: reliability-report is unavailable because the current lmbee CLI opens its database writable\n/);
      assert.ok(!existsSync(absentDb), 'reliability-report must not create a missing database file');

      // 2. Run against an existing database: assert it exits 2, exact error message, and does not alter the database
      const existingDb = join(lmctlTestDir, 'existing-reliability.db');
      writeFileSync(existingDb, 'test database sentinel payload\n');
      const hashBefore = createHash('sha256').update(readFileSync(existingDb)).digest('hex');
      const existingEnv = { ...env, LMCTL_DB: existingDb };

      const existingResult = failure(["lmctl", "reliability-report"], { env: existingEnv });
      assert.equal(existingResult.status, 2);
      assert.match(existingResult.stderr, /^error: reliability-report is unavailable because the current lmbee CLI opens its database writable\n/);
      const hashAfter = createHash('sha256').update(readFileSync(existingDb)).digest('hex');
      assert.equal(hashAfter, hashBefore, 'reliability-report must not alter an existing database');

      // Mutation controls: exit status 0, wrong error message, DB created/altered
      assert.throws(() => {
        const mutatedStatus = 0;
        assert.equal(mutatedStatus, 2);
      });
      assert.throws(() => {
        const mutatedStderr = absentResult.stderr.replace('reliability-report is unavailable because the current lmbee CLI opens its database writable', 'unavailable');
        assert.match(mutatedStderr, /^error: reliability-report is unavailable because the current lmbee CLI opens its database writable\n/);
      });
      assert.throws(() => {
        const dbCreated = true;
        assert.ok(!dbCreated, 'reliability-report must not create a missing database file');
      });
      assert.throws(() => {
        const mutatedHash = 'different-hash';
        assert.equal(mutatedHash, hashBefore, 'reliability-report must not alter an existing database');
      });
    });
  }

  const suiteDir = import.meta.dirname;
  const testRoot = join(suiteDir, '..');

  const sessionCases = execFileSync(process.execPath, [join(suiteDir, 'offline-session-commands.mjs')], {
    cwd: testRoot, env, encoding: 'utf8', timeout: 120000,
  });
  const sessionSummary = sessionCases.match(/(\d+) assertions: (\d+) pass, (\d+) fail/);
  assert.ok(sessionSummary, sessionCases);
  assert.equal(Number(sessionSummary[1]), Number(sessionSummary[2]), sessionCases);
  assert.equal(Number(sessionSummary[3]), 0, sessionCases);
  passed += Number(sessionSummary[1]);
  process.stdout.write(sessionCases);

  const routeCases = execFileSync(process.execPath, [join(suiteDir, 'live-price-route-contract.mjs')], {
    cwd: testRoot, env, encoding: 'utf8', timeout: 60000,
  });
  const routeSummary = routeCases.match(/(\d+) assertions: (\d+) pass, (\d+) fail/);
  assert.ok(routeSummary, routeCases);
  assert.equal(Number(routeSummary[1]), Number(routeSummary[2]), routeCases);
  assert.equal(Number(routeSummary[3]), 0, routeCases);
  passed += Number(routeSummary[1]);
  process.stdout.write(routeCases);

  const expectationCases = execFileSync(process.execPath, [join(suiteDir, 'observe-expectation-contract.mjs')], {
    cwd: testRoot, env, encoding: 'utf8', timeout: 60000,
  });
  const expectationSummary = expectationCases.match(/(\d+) assertions: (\d+) pass, (\d+) fail/);
  assert.ok(expectationSummary, expectationCases);
  assert.equal(Number(expectationSummary[1]), Number(expectationSummary[2]), expectationCases);
  assert.equal(Number(expectationSummary[3]), 0, expectationCases);
  passed += Number(expectationSummary[1]);
  process.stdout.write(expectationCases);

  // Native state/cron reads beyond the checks above (empty and seeded private DB, read-only invariant) and the retired
  // lmbee-era commands (queue, sites, fleet, service CLIs) that must refuse with their replacement hint.
  const nativeReadRun = spawnSync(process.execPath, [join(suiteDir, 'native-reads.mjs')], {
    cwd: testRoot, env, encoding: 'utf8', timeout: 300000,
  });
  const nativeReadCases = `${nativeReadRun.stdout ?? ''}${nativeReadRun.stderr ?? ''}`;
  const nativeReadSummary = nativeReadCases.match(/(\d+) assertions: (\d+) pass, (?:(\d+) skipped, )?(\d+) fail/);
  assert.ok(nativeReadSummary, nativeReadCases);
  assert.equal(Number(nativeReadSummary[4]), 0, nativeReadCases);
  assert.equal(nativeReadRun.status, 0, nativeReadCases);
  passed += Number(nativeReadSummary[2]);
  skipped += Number(nativeReadSummary[3] ?? 0);
  process.stdout.write(nativeReadCases);

  // Plain FILE.lms / URL runs (missing provider is an error, no adaptation), autorun URL adaptation, the no-API host
  // installer through `lmctl script` against loopback github.com/API emulators, and `lmctl script` modes.
  const runInstallRun = spawnSync(process.execPath, [join(suiteDir, 'run-install-commands.mjs')], {
    cwd: testRoot, env, encoding: 'utf8', timeout: 900000,
  });
  const runInstallCases = `${runInstallRun.stdout ?? ''}${runInstallRun.stderr ?? ''}`;
  const runInstallSummary = runInstallCases.match(/(\d+) assertions: (\d+) pass, (?:(\d+) skipped, )?(\d+) fail/);
  assert.ok(runInstallSummary, runInstallCases);
  assert.equal(Number(runInstallSummary[4]), 0, runInstallCases);
  assert.equal(runInstallRun.status, 0, runInstallCases);
  passed += Number(runInstallSummary[2]);
  skipped += Number(runInstallSummary[3] ?? 0);
  process.stdout.write(runInstallCases);

  runIntentCases({ root, env, bin, check });

  if (skipped > 0) {
    console.log(`${passed + skipped} assertions: ${passed} pass, ${skipped} skipped, 0 fail`);
  } else {
    console.log(`${passed} assertions: ${passed} pass, 0 fail`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}

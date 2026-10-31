// Mutation controls for rate-limit warning behavior and classifier.
// Verifies that mutating core guards and behavior causes corresponding tests to fail.

import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const source = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(source, '../..');
const root = await mkdtemp(join(tmpdir(), 'smoke-ratelimit-controls-'));

function command(bin, args, options = {}) {
  return new Promise(resolveResult => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { err += e.message; });
    child.on('close', code => resolveResult({ code, out, err }));
  });
}

try {
  const testDir = join(root, 'lmctl-test/tests');
  await mkdir(testDir, { recursive: true });
  for (const name of [
    'provider-smoke.mjs',
    'provider-smoke-ratelimit.test.mjs',
    'rate-limit-classifier.mjs',
    'rate-limit-vectors.mjs',
    'models-validity.mjs',
    'models-validity-inconclusive.test.mjs'
  ]) {
    await cp(join(source, name), join(testDir, name));
  }
  await cp(join(repo, 'live-config.mjs'), join(root, 'live-config.mjs'));
  await cp(join(repo, 'live-config.json'), join(root, 'live-config.json'));
  await mkdir(join(testDir, 'fixtures/models-validity'), { recursive: true });
  await cp(join(source, 'fixtures/models-validity'), join(testDir, 'fixtures/models-validity'), { recursive: true });

  const classifierPath = join(testDir, 'rate-limit-classifier.mjs');
  const smokePath = join(testDir, 'provider-smoke.mjs');
  const modelsValidityPath = join(testDir, 'models-validity.mjs');

  const origClassifier = await readFile(classifierPath, 'utf8');
  const origSmoke = await readFile(smokePath, 'utf8');
  const origModelsValidity = await readFile(modelsValidityPath, 'utf8');

  const runTest = (testFile = 'provider-smoke-ratelimit.test.mjs') =>
    command(process.execPath, ['--test', testFile], { cwd: testDir });

  // Baseline
  const baseline = await runTest();
  if (baseline.code !== 0) throw new Error('Baseline failed: ' + baseline.out + baseline.err);
  console.log('Baseline PASS');

  const mutations = [
    {
      name: 'model refusal negative guard removal',
      target: classifierPath,
      original: origClassifier,
      anchor: 'if (isRejectFirst(s) || isRefusalShaped(s) || isModelRefusal(s, modelId) || isStallOrTimeout(s)) return false;',
      replacement: 'if (isRejectFirst(s) || false || isStallOrTimeout(s)) return false;',
    },
    {
      name: 'stall/timeout negative guard removal',
      target: classifierPath,
      original: origClassifier,
      anchor: 'return /\\bstalled before first token\\b|\\bstalled\\b|ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out|idleTimeout/i.test(s);',
      replacement: 'return false;',
    },
    {
      name: 'reject-first rule: infrastructure/auth with 429 treated as error',
      target: classifierPath,
      original: origClassifier,
      anchor: "return s.split('\\n').some(line => line.trim() && REJECT_FIRST_PATTERNS.some(re => re.test(line.trim()))) || REJECT_FIRST_PATTERNS.some(re => re.test(s));",
      replacement: 'return false;',
    },
    {
      name: 'unknown error fail-open (treated as rate limit)',
      target: classifierPath,
      original: origClassifier,
      anchor: 'return RATE_LIMIT_PATTERNS.some(re => re.test(s));',
      replacement: 'return true;',
    },
    {
      name: 'id-subject requirement: bare config/cache phrases must not be refusal',
      target: classifierPath,
      original: origClassifier,
      anchor: 'if (isRejectFirst(s)) return false;\n\n  const mid',
      replacement: '/* no reject-first */\n\n  const mid',
    },
    {
      name: 'second signal restriction: second signal cannot rescue reject-first',
      target: classifierPath,
      original: origClassifier,
      anchor: 'export function classifyProviderFailure(text, provider = null, options = {}) {\n  const { raw, texts } = extractJudgedTexts(text);\n  if (texts.some(s => isRejectFirst(s) || isStallOrTimeout(s))) {',
      replacement: 'export function classifyProviderFailure(text, provider = null, options = {}) {\n  const { raw, texts } = extractJudgedTexts(text);\n  if (provider && checkProviderRatelimitSignal(provider, options)) return { isRateLimit: true, class: \'upstream_throttled\', message: extractProviderMessage(raw) };\n  if (texts.some(s => isRejectFirst(s) || isStallOrTimeout(s))) {',
    },
    {
      name: 'gate on warnings (exit 1 even on warnings only)',
      target: smokePath,
      original: origSmoke,
      anchor: 'process.exit(failed.length ? 1 : 0);',
      replacement: 'process.exit((failed.length || warned.length) ? 1 : 0);',
    },
    {
      name: 'mixed failures softened to WARN',
      target: smokePath,
      original: origSmoke,
      anchor: '} else if (failedChecks.every(x => x.attributableToRateLimit)) {',
      replacement: '} else if (failedChecks.some(x => x.attributableToRateLimit)) {',
    },
    {
      name: 'disable second signal (ratelimit)',
      target: classifierPath,
      original: origClassifier,
      anchor: 'if (checkProviderRatelimitSignal(provider, options)) {',
      replacement: 'if (false && checkProviderRatelimitSignal(provider, options)) {',
    },
    {
      name: 'wrong memory turn 3 reply softened to rate limit',
      target: smokePath,
      original: origSmoke,
      anchor: `      if (turns[n - 1]?.status !== 'ok') {
        const cl = classifyProviderFailure(turns[n - 1].error, p.id, { bin, env });
        if (cl.isRateLimit) {
          memoryRateLimit = true;
          if (!turnsMessage) turnsMessage = cl.message;
        }
      }`,
      replacement: `      if (turns.some(x => x.status !== 'ok')) {
        memoryRateLimit = true;
      }`,
    },
    {
      name: 'stopped early with missing turns softened to rate limit',
      target: smokePath,
      original: origSmoke,
      anchor: 'const turnsOk = Array.isArray(turns) && turns.length === n && turns.every(x => x.status === \'ok\');',
      replacement: 'const turnsOk = Array.isArray(turns) && turns.every(x => x.status === \'ok\');',
    },
    {
      name: 'checkProviderRatelimitSignal fallback to readings[0]',
      target: classifierPath,
      original: origClassifier,
      anchor: 'const r = readings.find(x => x.provider === provider);',
      replacement: 'const r = readings.find(x => x.provider === provider) || readings[0];',
    },
    {
      name: 'refusal regex misses no access',
      target: classifierPath,
      original: origClassifier,
      anchor: '/\\b(?:no access|do not have access)\\b/i.test(s)',
      replacement: 'false',
    },
    {
      name: 'models-validity classifier fallback removal',
      target: modelsValidityPath,
      original: origModelsValidity,
      testFile: 'models-validity-inconclusive.test.mjs',
      env: { LMCTL_BIN: '/home/mma/.local/bin/lmctl' },
      anchor: 'return text=>classifyTextForModelsValidity(text);',
      replacement: 'return null;',
    },
  ];

  for (const m of mutations) {
    if (!m.original.includes(m.anchor)) throw new Error('Missing anchor in ' + m.name);
    await writeFile(m.target, m.original.replace(m.anchor, m.replacement));
    const res = await (m.env ? command(process.execPath, ['--test', m.testFile], { cwd: testDir, env: { ...process.env, ...m.env } }) : runTest(m.testFile));
    const output = res.out + res.err;
    if (res.code === 0 || !output.includes('ERR_ASSERTION')) {
      throw new Error(`Mutation survived or invalid for ${m.name}\n${output}`);
    }
    console.log(`CAUGHT ${m.name}`);
    await writeFile(m.target, m.original);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

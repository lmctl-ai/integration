// Runs fabricated session observations through lib.lms observe_expectation (mono 009): the
// .lms contract is self-asserting; this wrapper checks its summary and pins the one control
// that must remain visible in the output -- a REAL declared/observed mismatch prints DIFF.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testRoot);
const bin = process.env.LMCTL_BIN || 'lmctl';

const result = spawnSync(bin, ['script', join('tests', 'observe-expectation.test.lms')], {
  cwd: repoRoot, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr || result.stdout);
const summary = result.stdout.match(/(\d+) assertions: (\d+) pass, (\d+) fail/);
assert.ok(summary, result.stdout);
assert.equal(Number(summary[1]), 7, result.stdout);
assert.equal(Number(summary[2]), 7, result.stdout);
assert.equal(Number(summary[3]), 0, result.stdout);
// The gate keeps its teeth: the real-mismatch case must be visible as a DIFF line.
assert.match(result.stdout, /DIFF lmplayer declared\/observed differ; not assumed equivalent/);
console.log('PASS observe_expectation contract: 7 self-asserted cases plus the mismatch control');
console.log('1 assertions: 1 pass, 0 fail');

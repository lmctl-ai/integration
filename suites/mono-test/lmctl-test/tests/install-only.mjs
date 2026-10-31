import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const bin = process.env.LMCTL_BIN || 'lmctl';
const result = spawnSync(bin, ['ratelimit', '--json'], { encoding: 'utf8', timeout: 120000 });
try {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.readings), 'ratelimit --json must return readings');
  console.log('PASS ratelimit succeeds with only the published lmctl package installed');
} catch (error) {
  console.error(`FAIL ratelimit install-only contract: ${error.message}`);
  process.exitCode = 1;
}

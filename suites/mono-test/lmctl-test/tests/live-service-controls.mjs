import assert from 'node:assert/strict';
import {isQuotaMessage, quotaSkipReason} from './live-service-support.mjs';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error instanceof Error ? error.message : String(error))); }
}

check('Codex exhausted bucket skips before provider calls', () => {
  const row = {provider: 'codex', status: 'ok', buckets: [{bucket_id: 'codex-weekly', used_fraction: 1, is_exhausted: true}]};
  assert.equal(quotaSkipReason('codex', {readings: [row]}), 'quota bucket exhausted: codex-weekly');
});
check('Agy third-party quota never gates Gemini Flash', () => {
  const row = {provider: 'agy', status: 'ok', buckets: [{bucket_id: '3p-weekly', used_fraction: 1, is_exhausted: true}]};
  assert.equal(quotaSkipReason('agy', {readings: [row]}), null);
});
check('Agy exhausted Gemini quota skips before provider calls', () => {
  const row = {provider: 'agy', status: 'ok', buckets: [{bucket_id: 'gemini-5h', used_fraction: 1, limit_reached: true}]};
  assert.equal(quotaSkipReason('agy', {readings: [row]}), 'quota bucket exhausted: gemini-5h');
});
check('Reader errors are red while missing credentials are a clean skip', () => {
  assert.throws(() => quotaSkipReason('codex', {readings: [{provider: 'codex', status: 'error', reason: 'reader_throttled'}]}), /reader status/);
  assert.equal(quotaSkipReason('codex', {readings: [{provider: 'codex', status: 'error', reason: 'credentials_missing'}]}), 'provider credentials or binary are unavailable');
  assert.equal(isQuotaMessage('usage limit reached; reset at 12:00'), true);
});

console.log(`${passed + failed} assertions: ${passed} pass, ${failed} fail`);
if (failed > 0) process.exitCode = 1;

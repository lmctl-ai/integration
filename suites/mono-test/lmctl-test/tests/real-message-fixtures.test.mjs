import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isModelRefusal, isRefusalShaped, classifyTextForModelsValidity } from './rate-limit-classifier.mjs';
import { probeResult } from './models-validity.mjs';

test('real message fixtures: provider refusal outputs classified correctly', () => {
  const fixturesPath = new URL('./fixtures/models-validity/real-refusals.json', import.meta.url);
  const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

  for (const item of fixtures) {
    const text = (item.stdout || '') + '\n' + (item.stderr || '');

    // 1. Accepts for probed modelId
    assert.equal(isModelRefusal(text, item.modelId), true, `real fixture must be refused for ${item.modelId}`);
    assert.equal(isModelRefusal(item.message, item.modelId), true, `real message text must be refused for ${item.modelId}`);
    assert.equal(isRefusalShaped(text), true, `real fixture must be refusal-shaped`);
    assert.equal(isRefusalShaped(item.message), true, `real message must be refusal-shaped`);

    const probeRes = probeResult({ code: item.code, out: item.stdout, err: item.stderr }, classifyTextForModelsValidity, item.modelId);
    assert.equal(probeRes, 'refused', `probeResult must be refused for ${item.modelId}`);

    // 2. Rejects for longer id where probed id is a prefix
    const longerId = `${item.modelId}-other`;
    assert.equal(isModelRefusal(text, longerId), false, `real fixture must not match longer id ${longerId}`);
    const probeResLonger = probeResult({ code: item.code, out: item.stdout, err: item.stderr }, classifyTextForModelsValidity, longerId);
    assert.equal(probeResLonger, 'error', `probeResult must be error for longer id`);

    // 3. Rejects when parenthesized id in text differs
    const diffText = text.replace(item.modelId, 'other-model');
    assert.equal(isModelRefusal(diffText, item.modelId), false, `must not match when parenthesized id differs`);
    const diffParsed = JSON.parse(item.stdout);
    diffParsed.result = item.message.replace(item.modelId, 'other-model');
    const probeResDiff = probeResult({ code: item.code, out: JSON.stringify(diffParsed), err: (item.stderr || '').replace(item.modelId, 'other-model') }, classifyTextForModelsValidity, item.modelId);
    assert.equal(probeResDiff, 'error', `probeResult must be error when parenthesized id differs`);

    // 4. Negative controls: infrastructure errors in JSON fields must be rejected (error)
    const badSuffixes = ['\nfile not found', '\npermission denied', '\nENOENT'];
    const unicodeSuffixes = ['\\u000afile not found', '\\u000apermission denied', '\\u000aENOENT'];

    for (const suf of badSuffixes) {
      const outResult = JSON.stringify({ is_error: true, result: item.message + suf });
      assert.equal(probeResult({ code: 1, out: outResult, err: '' }, classifyTextForModelsValidity, item.modelId), 'error', `result + ${suf} must be error`);
      const outError = JSON.stringify({ is_error: true, error: { message: item.message + suf } });
      assert.equal(probeResult({ code: 1, out: outError, err: '' }, classifyTextForModelsValidity, item.modelId), 'error', `error.message + ${suf} must be error`);
    }

    for (const suf of unicodeSuffixes) {
      const outUnicode = `{"is_error":true,"result":"${item.message}${suf}"}`;
      assert.equal(probeResult({ code: 1, out: outUnicode, err: '' }, classifyTextForModelsValidity, item.modelId), 'error', `unicode ${suf} must be error`);
      const outUnicodeErr = `{"is_error":true,"error":{"message":"${item.message}${suf}"}}`;
      assert.equal(probeResult({ code: 1, out: outUnicodeErr, err: '' }, classifyTextForModelsValidity, item.modelId), 'error', `unicode error ${suf} must be error`);
    }

    // 5. Reviewer full regressions: double-encoded JSON, JSON in error, and JSON stderr
    const doubleEncoded = JSON.stringify({ is_error: true, result: JSON.stringify(item.message + '\nfile not found') });
    assert.equal(probeResult({ code: 1, out: doubleEncoded, err: '' }, classifyTextForModelsValidity, item.modelId), 'error', 'double-encoded JSON must be error');

    const errorJsonString = JSON.stringify({ is_error: true, result: item.message, error: JSON.stringify({ message: 'file\nnot found' }) });
    assert.equal(probeResult({ code: 1, out: errorJsonString, err: '' }, classifyTextForModelsValidity, item.modelId), 'error', 'JSON error string must be error');

    const goodOut = JSON.stringify({ is_error: true, subtype: 'success', result: item.message });
    assert.equal(probeResult({ code: 1, out: goodOut, err: '{"error":"file\\nnot found"}' }, classifyTextForModelsValidity, item.modelId), 'error', 'escaped infra failure in JSON stderr must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: '["file\\nnot found"]' }, classifyTextForModelsValidity, item.modelId), 'error', 'JSON array stderr must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: '"file\\nnot found"' }, classifyTextForModelsValidity, item.modelId), 'error', 'JSON string stderr must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: '{"status":"failed"}' }, classifyTextForModelsValidity, item.modelId), 'error', 'arbitrary JSON stderr must be error');

    const unanchoredPre = JSON.stringify({ is_error: true, subtype: 'success', result: 'prefix ' + item.message });
    assert.equal(probeResult({ code: 1, out: unanchoredPre, err: '' }, classifyTextForModelsValidity, item.modelId), 'error', 'unanchored prefix must be error');
    const unanchoredPost = JSON.stringify({ is_error: true, subtype: 'success', result: item.message + ' postfix' });
    assert.equal(probeResult({ code: 1, out: unanchoredPost, err: '' }, classifyTextForModelsValidity, item.modelId), 'error', 'unanchored postfix must be error');

    // 6. Reviewer stderr rules & payloads:
    assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"error":"file\\nnot found"}' }, classifyTextForModelsValidity, item.modelId), 'error', 'Reviewer payload 1 must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: 'diagnostic\n{"error":"file\\nnot found"}' }, classifyTextForModelsValidity, item.modelId), 'error', 'Reviewer payload 2 must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: '[claude-code:unrecognized_model] {"model":"other-id","query_source":"sdk"}' }, classifyTextForModelsValidity, item.modelId), 'error', 'model mismatch in stderr must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: `[claude-code:unrecognized_model] {"model":"${item.modelId}","query_source":"sdk","extra":1}` }, classifyTextForModelsValidity, item.modelId), 'error', 'extra key in stderr must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: `[claude-code:unrecognized_model] {"model":"${item.modelId}","query_source":"invalid"}` }, classifyTextForModelsValidity, item.modelId), 'error', 'query_source not in allowlist must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: '' }, classifyTextForModelsValidity, item.modelId), 'refused', 'empty stderr must be refused');
    assert.equal(probeResult({ code: 1, out: goodOut, err: item.stderr }, classifyTextForModelsValidity, item.modelId), 'refused', 'real stderr line must be refused');
    assert.equal(probeResult({ code: 1, out: goodOut, err: item.stderr + '\n' }, classifyTextForModelsValidity, item.modelId), 'refused', 'real stderr line with trailing newline must be refused');
    assert.equal(probeResult({ code: 1, out: goodOut, err: `prefix ${item.stderr}` }, classifyTextForModelsValidity, item.modelId), 'error', 'unanchored prefix in stderr must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: `${item.stderr} postfix` }, classifyTextForModelsValidity, item.modelId), 'error', 'unanchored postfix in stderr must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: `[claude-code:unrecognized_model] {"model":"other","model":"${item.modelId}","query_source":"sdk"}` }, classifyTextForModelsValidity, item.modelId), 'error', 'duplicate model key (first) must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: `[claude-code:unrecognized_model] {"model":"${item.modelId}","model":"other","query_source":"sdk"}` }, classifyTextForModelsValidity, item.modelId), 'error', 'duplicate model key (second) must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: `[claude-code:unrecognized_model] {"model":"${item.modelId}","query_source":"sdk","query_source":"sdk"}` }, classifyTextForModelsValidity, item.modelId), 'error', 'duplicate query_source key must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: `[claude-code:unrecognized_model] {"query_source":"sdk","model":"${item.modelId}"}` }, classifyTextForModelsValidity, item.modelId), 'error', 'reordered keys must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: `[claude-code:unrecognized_model] { "model": "${item.modelId}", "query_source": "sdk" }` }, classifyTextForModelsValidity, item.modelId), 'error', 'extra whitespace inside JSON must be error');
    assert.equal(probeResult({ code: 1, out: goodOut, err: ` [claude-code:unrecognized_model] {"model":"${item.modelId}","query_source":"sdk"}` }, classifyTextForModelsValidity, item.modelId), 'error', 'leading whitespace must be error');
  }
});

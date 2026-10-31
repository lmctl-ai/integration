import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const testsDir = new URL('./', import.meta.url);
const bin = process.env.LMCTL_BIN || 'lmctl';
const help = execFileSync(bin, ['--help'], { encoding: 'utf8' });
const commands = [...help.matchAll(/^  ([a-z][a-z-]+) {2,}/gm)].map((match) => match[1]);
assert.ok(commands.length > 0, 'could not read commands from lmctl --help');

const invoked = new Set();
for (const name of readdirSync(testsDir)) {
  if (!/\.(?:lms|mjs)$/.test(name)) continue;
  const source = readFileSync(new URL(name, testsDir), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(?:#|\/\/|\*)/.test(line))
    .join('\n');
  for (const match of source.matchAll(/\[\s*["']lmctl["']\s*,\s*["']([a-z][a-z-]+)["']/g)) {
    invoked.add(match[1]);
  }
}

const missing = commands.filter((name) => !invoked.has(name));
const allowlist = JSON.parse(readFileSync(new URL('./command-coverage-allowlist.json', import.meta.url), 'utf8'));
assert.ok(allowlist && typeof allowlist === 'object' && !Array.isArray(allowlist), 'command coverage allowlist must be a JSON object');
for (const [name, reason] of Object.entries(allowlist)) {
  assert.ok(commands.includes(name), `allowlist entry ${name} is not in lmctl --help`);
  assert.ok(typeof reason === 'string' && reason.trim().length > 0, `allowlist entry ${name} needs a reason`);
}
const uncovered = missing.filter((name) => !Object.hasOwn(allowlist, name));
const staleAllowlist = Object.keys(allowlist).filter((name) => !missing.includes(name));
console.log(`commands: ${commands.length}; invoked in tests: ${commands.length - missing.length}; missing: ${missing.length}`);
console.log(`missing: ${missing.join(', ') || '(none)'}`);
if (Object.keys(allowlist).length > 0) {
  for (const [name, reason] of Object.entries(allowlist)) console.log(`allowlisted: ${name} — ${reason}`);
}
assert.deepEqual(uncovered, [], 'an advertised command lacks an executing test and an allowlist reason');
assert.deepEqual(staleAllowlist, [], 'remove allowlist entries once executing coverage exists');

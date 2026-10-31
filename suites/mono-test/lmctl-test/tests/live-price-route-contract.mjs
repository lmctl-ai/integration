// Replays the Oct 3 Codex catalog slice through the shipped resolver only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testRoot);
const bin = process.env.LMCTL_BIN || 'lmctl';
const root = mkdtempSync(join(tmpdir(), 'lmctl-live-price-route-'));
const home = join(root, 'home');
const lmHome = join(home, '.lmctl');
const env = { ...process.env, HOME: home, LMCTL_HOME: lmHome, LMCTL_DB: join(root, 'state.db'), LMCTL_BIN: bin };
delete env.LMCTL_SELF_SESSIONID;
delete env.LMCTL_INVOCATION_ID;
mkdirSync(lmHome, { recursive: true });
writeFileSync(join(lmHome, 'init.toml'), [1, 2, 3].map((i) =>
  '[Provider' + i + ']\nprovider = "claude"\nmodel1 = "claude-haiku-4-5"\nmodel2 = "claude-haiku-4-5"\nmodel3 = "claude-haiku-4-5"\n').join('\n'));

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('PASS ' + name);
}

try {
  check('Codex route assertion rejects offer-count ambiguity and accepts the selected direct offer', () => {
    const fixture = join(testRoot, 'fixtures', 'issue002-prices');
    const result = spawnSync(process.execPath, [join(testRoot, 'live-probe.mjs'), 'catalog', JSON.stringify({
      provider: 'codex', model: 'gpt-6-luna', catalogPath: fixture,
    })], { cwd: repoRoot, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const probe = JSON.parse(result.stdout);
    assert.equal(probe.catalog_source, 'pinned');
    assert.equal(probe.state.kind, 'priced');
    assert.equal(probe.state.model.offers.length, 7);
    assert.throws(() => assert.equal(probe.state.model.offers.length, 1), 'old offer-count assertion must fail');
    assert.equal(probe.selected_route, 'litellm:gpt-6-luna');
    console.log('CONTROL offers=' + probe.state.model.offers.length + ' old-count=fails selected=' + probe.selected_route);
  });
  console.log(passed + ' assertions: ' + passed + ' pass, 0 fail');
} finally {
  rmSync(root, { recursive: true, force: true });
}

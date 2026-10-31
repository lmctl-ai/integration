import { realpathSync } from 'node:fs';

export function requiredLmctlBin(value) {
  try {
    if (!value) throw new Error('missing value');
    return realpathSync(value);
  } catch {
    throw new Error(
      'LMCTL_BIN is required and must resolve to the lmctl binary of an INSTALLED ' +
      '@lmctl-ai/lmctl (not a checkout or a symlink into one).\n' +
      'Example (from the repository root):\n' +
      'npm install --prefix /tmp/lmctl-prompt-release --no-audit --no-fund --ignore-scripts @lmctl-ai/lmctl@0.2.118\n' +
      'LMCTL_BIN=/tmp/lmctl-prompt-release/node_modules/.bin/lmctl node --test lmctl-test/tests/prompt-precondition.test.mjs'
    );
  }
}

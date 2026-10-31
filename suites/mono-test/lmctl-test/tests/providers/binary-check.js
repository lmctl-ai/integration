/**
 * Provider-binary-on-PATH + runtime pre-flight check.
 *
 * Used by `lmctl lint` (warn the user about missing / broken CLI
 * installs at config-validation time) and `lmctl autocode` (HARD
 * GATE — refuse to spawn `lmctl seed` / `lmctl chat` if any
 * declared provider's CLI is missing or fails to execute, so we
 * never half-create a team).
 *
 * Implementation: `<binary> --version`. Cross-platform (no `which`
 * / `where` branching) and verifies strictly more than existence —
 * the binary must actually run to a clean exit. Catches:
 *   - not installed        → spawn returns ENOENT
 *   - installed but broken → non-zero exit (missing deps, bad libs,
 *                            permission denied, etc.)
 *   - installed and OK     → exit 0 with a version string on stdout
 *
 * All supported providers (claude/codex/copilot/gemini/opencode/lmplayer/qwen/agy)
 * accept `--version` and early-exit before any auth/config check, so
 * the pre-flight is cheap and safe to run on every lint/autocode.
 */
import * as childProcess from "node:child_process";
/**
 * Map from our `ProviderName` → expected CLI binary on PATH.
 *
 * All entries are standalone binaries — `gh copilot` is intentionally
 * NOT here. lmctl's copilot transport spawns the standalone `copilot`
 * binary (see `src/cli/transports/acp.ts:58`), not the `gh` extension.
 *
 * Public-readable so test fixtures and audit/cache surfaces can read
 * the same canonical mapping. Mutating it at runtime is unsupported.
 */
export const PROVIDER_BINARIES = {
    claude: "claude",
    codex: "codex",
    copilot: "copilot",
    gemini: "gemini",
    opencode: "opencode",
    lmplayer: "lmplayer",
    qwen: "qwen",
    agy: "agy",
    kimi: "kimi",
    dsh: "dsh",
    hermes: "hermes",
    miniplayer: "miniplayer",
    muse: "muse",
    pi: "pi",
};
/**
 * Per-provider one-line install hint shown in error messages from
 * `lint` and `autocode`. Kept terse — the goal is "what URL do I
 * paste into a browser," not a full installer guide.
 */
export const PROVIDER_INSTALL_HINTS = {
    claude: "https://docs.claude.com/code",
    codex: "https://github.com/openai/codex",
    copilot: "https://docs.github.com/copilot/cli",
    gemini: "https://github.com/google-gemini/gemini-cli",
    opencode: "https://opencode.ai",
    lmplayer: "Install lmplayer and ensure the lmplayer binary is on PATH.",
    qwen: "https://github.com/QwenLM/qwen-code",
    agy: "https://antigravity.google",
    kimi: "https://github.com/MoonshotAI/kimi-code",
    dsh: "https://github.com/deepseek-ai/deepseek-harness",
    hermes: "https://github.com/NousResearch/hermes-agent",
    pi: "https://github.com/badlogic/pi-mono",
};
/**
 * Probe a single binary by running `<binary> --version`. This is
 * strictly more rigorous than a PATH existence check: if the binary
 * is installed but broken (missing libraries, bad permissions, wrong
 * Node version for a JS CLI, etc.) we see it here instead of at
 * `lmctl seed` time.
 *
 * - `status === 0`             → installed and runnable
 * - `status !== 0 && status != null` → found, but fails at runtime
 * - `status === null`          → spawn itself failed (ENOENT = not
 *                                installed; other codes treated the
 *                                same way for our purposes)
 */
function probeBinary(binary, spawnSync) {
    try {
        const result = spawnSync(binary, ["--version"], {
            encoding: "utf-8",
            timeout: 5000,
        });
        if (result.status === 0) {
            const raw = (result.stdout ?? "").toString().trim();
            const version = raw.split(/\r?\n/, 1)[0]?.trim() || undefined;
            return { found: true, version };
        }
        if (result.status === null) {
            return { found: false, failureMode: "not installed" };
        }
        return { found: false, failureMode: "runs but failed" };
    }
    catch {
        // spawnSync threw — treat as not installed.
        return { found: false, failureMode: "not installed" };
    }
}
/**
 * Env-var escape hatch for CI / test environments where provider CLIs
 * aren't installed. When `LMCTL_SKIP_BINARY_CHECK=1` is set, this
 * function short-circuits — every declared provider is treated as
 * found with `version: "(skipped)"`. Production users should NEVER
 * set this; the pre-flight catches missing tools before they cause
 * mid-run failures, which is the entire point.
 *
 * Intentionally NOT auto-detected via `process.env.CI`: that's a
 * convention used by many tools for many purposes, and we want the
 * opt-out to be deliberate and grep-able.
 */
const SKIP_ENV_VAR = "LMCTL_SKIP_BINARY_CHECK";
/**
 * Check each DISTINCT provider in `providers` against PATH. Order of
 * the returned array matches first-occurrence order in the input.
 * Duplicates collapse to one result. Unknown providers (not in
 * `PROVIDER_BINARIES`) yield `binary: "<unknown>", found: false`
 * rather than throwing — the caller formats the user-facing error.
 *
 * When `LMCTL_SKIP_BINARY_CHECK=1` is set in the environment, every
 * KNOWN provider is reported as found with `version: "(skipped)"`
 * and unknown providers are STILL surfaced as errors (a typo in a
 * teamfile shouldn't be hidden by a CI flag).
 */
export function checkProviderBinaries(providers, options = {}) {
    // Env-skip only applies when the caller is using the DEFAULT
    // spawnSync. Tests that inject a custom stub are explicitly
    // exercising the probe logic and would be silently neutered if
    // the env var leaked into them. Production callers never pass a
    // stub, so the CI escape hatch still applies wherever it matters.
    const skipChecks = options.spawnSync === undefined && process.env[SKIP_ENV_VAR] === "1";
    const spawnSync = options.spawnSync ?? childProcess.spawnSync;
    const seen = new Set();
    const out = [];
    for (const provider of providers) {
        if (seen.has(provider))
            continue;
        seen.add(provider);
        const binary = PROVIDER_BINARIES[provider];
        if (!binary) {
            // Unknown providers stay errors even with the env flag set —
            // a typo in a teamfile (`provider=clade`) should not be hidden
            // by a CI shortcut. The flag covers the "binary not installed
            // on this machine" case, not the "this name has no mapping" case.
            out.push({
                provider,
                binary: "<unknown>",
                found: false,
                failureMode: "not installed",
            });
            continue;
        }
        if (skipChecks) {
            out.push({ provider, binary, found: true, version: "(skipped)" });
            continue;
        }
        const probe = probeBinary(binary, spawnSync);
        if (probe.found) {
            out.push({ provider, binary, found: true, version: probe.version });
        }
        else {
            out.push({
                provider,
                binary,
                found: false,
                failureMode: probe.failureMode,
            });
        }
    }
    return out;
}
/**
 * Format a missing-binary error line for stderr/lint output. Keeps
 * the wording consistent across `lint` and `autocode` so users can
 * grep for `provider "<name>" binary` in CI.
 */
export function formatMissingBinaryError(check) {
    if (check.binary === "<unknown>") {
        return `unknown provider "${check.provider}" — no binary mapping (allowed: ${Object.keys(PROVIDER_BINARIES).join(", ")})`;
    }
    const hint = PROVIDER_INSTALL_HINTS[check.provider];
    const installNote = hint ? ` (install via ${hint})` : "";
    if (check.failureMode === "runs but failed") {
        return `provider "${check.provider}" binary '${check.binary}' found but \`${check.binary} --version\` failed to run cleanly — check install integrity${installNote}`;
    }
    return `provider "${check.provider}" binary '${check.binary}' not installed${installNote}`;
}
//# sourceMappingURL=binary-check.js.map
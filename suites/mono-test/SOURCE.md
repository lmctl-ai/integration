# Source of the vendored suites

- Upstream: `lmctlhq/lmctl-mono-test` (private), directory `lmctl-test/`, commit `ada13da` (2026-10-31), cloned read-only
  from the GitHub remote. The `lmctl-test/tests` directory has 88 entries; `inventory.tsv` classifies every one.
- Migration is the operator's design (release pipeline, section 3): the mockable tiers move to public Actions, the live
  tier stays private. The vendored files contain no credentials (scanned for key patterns before copying).
- Reproduce: `bash vendor.sh PATH_TO_CLONE`. Entries classified `skip-*` in `inventory.tsv` are not copied.
- Edits to upstream files (all in `vendor.sh`, each must match or the script fails):
  `command-literals.lms`, `native-git.lms`, `schema-import.lms`, `pref-overlay.lms`, `schema-nocap.lms` replace the
  hard-coded nvm path `/home/mma/.nvm/versions/node/v24.18.0/bin` by `env("NODE_BIN", "node")` / `env("NODE_DIR", "/usr/bin")`
  (the runner exports both). Nothing else is changed.
- Upstream targets the current mono main; the published lmctl can be behind it. Known skew lives in `allowlist.json`
  with an owner and an expiry date, never as a silent skip.

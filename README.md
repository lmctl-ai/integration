# lmctl-ai/integration

Integration scenarios and reusable GitHub Actions for **published** lmctl, lmscript and lmcode hosts.
Everything here installs released artifacts (npm `@lmctl-ai/lmctl`, GitHub release assets) and tests those,
not a source checkout. The repo is public so Actions minutes are free. Results are advisory: no release
workflow waits for them.

## Action `setup`

```yaml
- uses: lmctl-ai/integration/actions/setup@<full commit sha>   # pin by sha; this repo has no tags yet
  with:
    lmctl: latest            # latest | staging | X.Y.Z | none
    tools: lmmock@v0.1.30+examples.tar.gz,lmgit@latest
    miniplayer: ""           # full 40-hex commit of lmctl-ai/miniplayer (no release exists), or empty
```

- lmctl is installed from npm into a private prefix under `RUNNER_TEMP` (never `-g`, never `~/.lmctl`). The exact
  resolved version is an output (`lmctl-version`) and goes to the job summary. A tag that does not resolve fails
  with the tag in the message.
- Each `NAME[@TAG][+EXTRA_ASSET...]` in `tools` downloads `NAME-{linux,macos}-{x64,arm64}` (or
  `NAME-windows-x64.exe`) from the release of `lmctl-ai/NAME` and checks it against the release `SHA256SUMS`
  before installing it. Extra assets (for lmmock `examples.tar.gz`) are verified the same way and exported as
  `INTEGRATION_ASSETS_<NAME>`. Only the download is retried (3 attempts); a checksum failure never is.
- Known quirk: locally (not on a clean runner) miniplayer sometimes answers the T1 prompt with a tool result from
  lmmock's handler instead of `pong`, so T1 asserts status, a non-empty reply and that the mock saw the request.
- Not covered yet: Windows runs (scripts are bash and Git-Bash friendly, untested), a second compat compiler
  slot for hosts still on an older bytecode version.

## Workflow `e2e.yml`

Runs on push, pull request, nightly, `workflow_dispatch` and as a reusable workflow:

```yaml
jobs:
  e2e:
    uses: lmctl-ai/integration/.github/workflows/e2e.yml@<full commit sha>
    with:
      integration-ref: <the same sha>
      lmctl: latest,staging
      lmmock: pinned,latest
```

`reuse-check.yml` (manual, and on changes to the workflow or action) proves both reuse paths: the workflow called as
a reusable workflow and the action referenced as `lmctl-ai/integration/actions/setup@<sha>` the way another repo would.
`gh workflow run e2e.yml -f lmctl=9.9.9` is the workflow-level red control (the run fails in `setup` naming the tag).

Jobs: `plan` (matrix from inputs and `versions.lock`), `selftest` (setup scripts with a fake `gh`, plus
the checksum, tag and pin controls) and `scenarios` (one leg per `{lmctl} x {lmmock}`).

## Scenarios

| Tier | Path | Chain | Needs |
|---|---|---|---|
| T0 | `scenarios/t0-claudemock` | lmscript `lm_prompt` to the in-process ClaudeMock provider (ok, scripted error, empty reply, delayed reply) | published lmctl only, no network |
| T0 | `scenarios/t0-fanout` | `lm_fanout` over three ClaudeMock members: slot order preserved, scripted error, ok-but-empty | published lmctl only |
| T0 | `scenarios/t0-provider-smoke-mock` | the shape of mono-test `provider-smoke.mjs` (fresh seed, ping, three-turn conversation, provider error fails the case) against ClaudeMock instead of a live vendor | published lmctl only |
| T1 | `scenarios/t1-lmmock-ai` | lmscript, lmctl, `miniplayer acp`, HTTP, lmmock `llm-api.lms`; asserts the mock itself saw model `mock-agent` | lmctl, lmmock, miniplayer |
| T1 | `scenarios/t1-lmmock-modes` | same chain, one `lmmock exec` per mode (ok, retry, unauthorized, rate-limit, server-error, bad-json); asserts lmctl `error_class` and, through lmmock `GET /__requests`, how many requests the mock served (the 429 attempt of `retry` really happened) | lmmock with `/__requests` (v0.1.35+) and `retry` on Responses (v0.1.36+) |

Rules every scenario follows:

- Run through `scripts/run-scenario.sh`: a fresh copy, a private `HOME`, `LMCTL_DB` and cache, and the lmctl
  session variables removed (`scripts/hermetic.sh`). Inside an lmctl session `LMCTL_SELF_SESSIONID` otherwise
  makes every `lm_prompt` fail with a session error.
- The mock lives and dies with `lmmock exec ... -- <test command>`; no background server, no fixed port.
- `status: "ok"` is not success: a scenario also checks the reply (an ok status with an empty reply is a failure).
- No timeout or hang scenarios; the job `timeout-minutes` is the only guard.
- Scripts pass `--no-preflight` to lmscript (the default dry preflight would run effects twice).

## PR gate

`e2e.yml` runs on every pull request; the job `gate` is the single required check name (it is red unless `plan`,
`selftest`, every `scenarios` leg, `suite-controls` and every `mono-test` leg are green). Branch protection is not
switched on (this repo is wiki-style: small commits straight to main); mark `gate` as required in a ruleset when the
operator wants merges blocked. Control: a PR that swaps one scripted reply (ping to pang) turns the T0 legs and `gate`
red (PR 1, run 41220193881, closed unmerged).

## Ported mono-test tier

`suites/mono-test` is the mockable part of `lmctlhq/lmctl-mono-test` (`lmctl-test/`, 88 test entries, source commit
`ada13da`) running against the INSTALLED lmctl: `node suites/mono-test/run.mjs` (see `SOURCE.md`).

- `inventory.tsv` classifies all 88 entries: ported (run), support (library/fixture of a ported entry), skip-host (needs
  a lmctl-mono source checkout or the operator's machine), skip-live (needs credentials, real vendors or the network).
- `run.mjs` runs each suite in a private HOME and database, with the lmctl session markers removed and a clean PATH
  (node, lmctl, `INTEGRATION_BIN`, `/usr/bin`, `/bin`), so provider CLIs of the host stay invisible.
- Version skew is never silently green: `allowlist.json` entries need `suite`, `match` (a substring of the failing line),
  `reason`, `owner` and `expires`; a failure covered by an unexpired entry is ALLOWED, an expired or missing entry is red,
  and a stale entry of a green suite is reported.
- `vendor.sh PATH_TO_CLONE` reproduces the tree; its only edits to upstream files are the NODE_BIN / NODE_DIR portability
  patches (the upstream hard-codes an nvm path).

Controls: `tests/suite-controls.sh` (runner semantics: uncovered failure red, covered ALLOWED, expired red, silent crash red;
mutations of the code under test for the pure suites listed in `mutations.json`) and
`node suites/mono-test/run.mjs --control broken-bin` (a lmctl that exits 0 and prints nothing must turn every lmctl-driven
suite red; a suite that stays green is reported VACUOUS and fails the job).

## What is NOT portable yet

| Not ported | Why | Where it goes |
|---|---|---|
| Live provider smoke (`provider-smoke.mjs` against codex, agy, claude, qwen, dsh, lmplayer; `provider-commands.mjs`, the ~50 minute live command matrix, `live.lms`, `prompt.lms`, `cost-live-cases`, `merged-api-live`, `pref-overlay-live`, `lmplayer-live`) | real vendor accounts and quota; secrets cannot live in a public repo | opt-in scheduled oracle on the awsspot box (design slice 5), never a gate; replaced here by ClaudeMock and lmmock cases |
| `lmbee-test` (AWS e2e), `lmctl-cron-test` (live-model cron), `tmuxdrive` (TUI replay) | AWS account and live models; tmux driver not migrated yet | awsspot oracle / later slice |
| awsspot box scripts (`release-pipeline.sh`, `gate-attest.sh`, `periodic-check.sh`, clean-clone gate) | the box is private infrastructure; the design retires the gate | stays in the private org until slice 6 |
| DAL tests 01 to 07, `doc-examples.lms` | import lmctl-mono source builds (`lmctl-src/dist`) or the source docs, which the npm package does not ship | need a mono checkout from public CI (operator decision O1) |
| `mapping*.lms`, `unpinned.lms`, `read.lms`, `prohibitions.lms` | read the operator's teamfiles and live ratelimit readings, or download the live catalog from lmctl.com | not mockable without redesign |
| Three `models-validity*` cases and one inconclusive case | read the awsspot gate scripts or a built mono package | skipped by name in `suites.json` |

## Controls (each must fail on the deliberate break)

`tests/setup-selftest.sh`: corrupted `SHA256SUMS`, corrupted extra-asset checksum, missing checksum entry, unknown
host tag, malformed and unknown lmctl tag, branch name as miniplayer pin.
`tests/scenario-controls.sh`: wrong expected reply turns T0 red, empty-reply case, session marker exported with and
without the scrub, swapped fanout prompts, removed `scriptContains` error and total entries (red naming the mocked error text),
unreachable base URL turns T1 red, wrong expected `error_class` or request count turns T1 modes red.

## Pins

`versions.lock` holds the lmmock tag and the miniplayer commit; `latest` legs run alongside as early warning.
miniplayer is built from source until it publishes releases.

License: MIT, Lattice Systems LLC.

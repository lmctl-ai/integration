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
| T1 | `scenarios/t1-lmmock-ai` | lmscript, lmctl, `miniplayer acp`, HTTP, lmmock `llm-api.lms`; asserts the mock itself saw model `mock-agent` | lmctl, lmmock, miniplayer |

Rules every scenario follows:

- Run through `scripts/run-scenario.sh`: a fresh copy, a private `HOME`, `LMCTL_DB` and cache, and the lmctl
  session variables removed (`scripts/hermetic.sh`). Inside an lmctl session `LMCTL_SELF_SESSIONID` otherwise
  makes every `lm_prompt` fail with a session error.
- The mock lives and dies with `lmmock exec ... -- <test command>`; no background server, no fixed port.
- `status: "ok"` is not success: a scenario also checks the reply (an ok status with an empty reply is a failure).
- No timeout or hang scenarios; the job `timeout-minutes` is the only guard.
- Scripts pass `--no-preflight` to lmscript (the default dry preflight would run effects twice).

## Controls (each must fail on the deliberate break)

`tests/setup-selftest.sh`: corrupted `SHA256SUMS`, corrupted extra-asset checksum, missing checksum entry, unknown
host tag, malformed and unknown lmctl tag, branch name as miniplayer pin.
`tests/scenario-controls.sh`: wrong expected reply turns T0 red, empty-reply case, session marker exported with and
without the scrub, unreachable base URL turns T1 red.

## Pins

`versions.lock` holds the lmmock tag and the miniplayer commit; `latest` legs run alongside as early warning.
miniplayer is built from source until it publishes releases.

License: MIT, Lattice Systems LLC.

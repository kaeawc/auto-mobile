# CircleCI Linux shadow lane

GitHub Actions is the authoritative CI. CircleCI additionally runs Linux mirrors
of the Node and shell validation jobs on every pull request so that capacity on
the CircleCI open-source plan is used and the two can be compared before any
required check moves.

## Jobs

`.circleci/continue_config.yml`, workflow `linux-pr`, selected by the `run-linux`
pipeline parameter. `.circleci/config.yml` sets it with the `.*` path-filter
mapping, so any PR that changes a file runs the lane.

| CircleCI job                         | Mirrors (pull_request.yml)    |
| ------------------------------------ | ----------------------------- |
| `linux-fast-validation`              | `fast-validation`             |
| `linux-node-checks`                  | `node-checks`                 |
| `linux-node-build-and-test`          | `ts-build-and-test`           |
| `linux-node-host-integration-tests`  | `node-host-integration-tests` |
| `linux-webrtc-publisher-integration` | `webrtc-integration-test`     |
| `linux-bats-tests`                   | `bats-tests`                  |

All but the WebRTC job run on the `linux` executor (`cimg/openjdk:21.0-node`, `large`: 4 vCPU, 8 GB;
`xlarge` is not in the open-source Docker plan). A container reports the host's
core count, so the executor pins `AUTOMOBILE_UNIT_TEST_WORKERS` and
`AUTOMOBILE_BATS_JOBS` to values suited to 4 vCPU. Fast Validation installs
ShellCheck 0.9.0 (the version the shell validators baseline) and Ruby (the
dependabot validator).

`linux-webrtc-publisher-integration` overrides the image with
`cimg/openjdk:21.0-browsers` (Node plus Chrome for the WHEP decode step), installs
FFmpeg with apt, and caches the MediaMTX binary keyed on its runner script.

## Post-merge (main)

Workflow `main-linux`, selected by `run-main-linux`. The setup job
`detect-main-macos-changes` diffs `HEAD~1..HEAD` against the `run-main-linux`
lines of `.circleci/main-macos-paths.txt` (`src/`, `test/`, `scripts/`,
`benchmark/`, `schemas/`, package and TypeScript config, `.circleci/`). Jobs:
`linux-fast-validation`, `linux-node-checks`, `linux-node-host-integration-tests`
(the ubuntu leg of merge.yml's `node-host-integration-tests`) and
`linux-benchmark-context-thresholds` (merge.yml's `benchmark-context-thresholds`:
`bun run benchmark-context` fails on an exceeded threshold; the report is stored
as an artifact).

Each job first runs `scripts/ci/circleci-main-superseded.sh run-main-linux` and
halts when a newer main commit touches the same group, so a merge burst runs once
for the latest commit.

## Nightly

Workflow `nightly-linux`, selected by `run-nightly-linux`, runs `linux-nightly-node`,
which mirrors nightly.yml's advisory Node jobs as steps that each run
`when: always`: the randomized unit lane (seed is `$CIRCLE_BUILD_NUM`), the pinned
Claude Code elicitation conformance test (same npm-packed binary and version as
nightly.yml, exposed as `AUTOMOBILE_CLAUDE_BIN`) and the auto-advance race guard.

One-time owner step: CircleCI > Project Settings > Triggers > add a scheduled
trigger on `main` with pipeline parameter `run-nightly-linux` = `true`. The
trigger is not created by the repository.

## BATS

`linux-bats-tests` runs `scripts/ci/run-bats.sh unit` then `integration`. The
CircleCI image lacks the GitHub runner image's tool versions, so the job installs
BATS 1.14.0, ShellCheck 0.9.0, jq 1.7.1, yq 4.49.2, ripgrep and GNU parallel
before running. Logs go to the `ci-logs/` artifacts (`bats-failures.txt` lists
every `not ok`).

## Differences from the GitHub jobs

- No change detection: each job always runs its full set, where GitHub gates
  steps on `detect-changes` outputs.
- No GitHub token: the benchmark PR comment, artifact uploads and the
  contended-runner rerun dispatch are omitted; reports go to CircleCI artifacts.
- The PR base is `git merge-base origin/main HEAD` rather than the event's base SHA.
- Checkout is the LFS-free clone shared with the macOS jobs.

## Capacity

The open-source plan allows 30 concurrent Linux jobs and is not subject to the
Free plan's monthly credit cap. These jobs are not required checks, so a missing
or red CircleCI run never blocks a merge.

## Promotion

To make a mirror authoritative, swap the `green-main` ruleset contexts from the
GitHub job name to `ci/circleci: <job>` and delete the GitHub job in the same
change. Do not delete a GitHub job first: its required context would stop
reporting.

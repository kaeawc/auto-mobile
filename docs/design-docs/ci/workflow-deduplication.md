# Workflow de-duplication: audit and plan

Audit and plan for #11872. Measured on main at `bc14f626663` with
`scripts/ci/workflow-duplication-report.sh` (repeatable; the bats test pins its arithmetic).

## What is duplicated

`pull_request.yml` and `merge.yml` define 16 job ids in common. "Shared" is the percentage of the
larger job body's non-comment lines (order-insensitive) that appear in both; the differences are
almost all `needs:`, `if:`, `runs-on:` and matrix gating.

```
job                                     A      B  shared     pct
android-device-webrtc                  50     49      48     96%
bats-tests                             89     66      48     53%
build-android-control-proxy            36     32      32     88%
build-desktop-core                     16     14      14     87%
build-ide-plugin                       16     16      14     87%
build-playground-app                   45     31      27     60%
desktop-app-unit-tests                 16     16      14     87%
desktop-core-unit-tests                37     37      34     91%
detekt                                 89     50      36     40%
ide-plugin-unit-tests                  16     17      14     82%
installer-minimal                     111     54      45     40%
junit-runner-unit-tests                34     24      24     70%
kotlin-code-coverage                   31     29      20     64%
node-host-integration-tests            38     47      27     57%
swift-code-coverage                    75     94      14     14%
webrtc-integration-test                43     36      36     83%
shared jobs: 16
```

Four of the jobs (`build-desktop-core`, `build-ide-plugin`, `desktop-app-unit-tests`,
`ide-plugin-unit-tests`) are already thin callers of composite actions
(`.github/actions/ci-*`); their remaining difference is gating only. The audit's
original 12-of-16 near-identical count has not shrunk since it was written, but the worst copies
are now the ones with real differences, not copy-paste drift.

Step-level repetition across the workflows: 117 `actions/checkout`, 29 `oven-sh/setup-bun` (all at
`bun-version: 1.4.4`, written out in 12 workflow files), and four action versions that have drifted
from the rest: `actions/cache@v4` (2, against 16 `@v5`), `actions/upload-artifact@v4` (2, against 83
`@v6`), `actions/setup-java@v4` (1, against 8 `@v5`).

## The constraint that shapes the plan

Required status contexts live in the `green-main` ruleset and name the **job**, not the workflow.
These shared jobs are required checks: `Build CtrlProxy APK`, `Build Desktop Core Module`,
`Build IDE Plugin`, `Build Playground App`, `Installer Minimal (<os>)`, `Run CtrlProxy Unit Tests`,
`Run Desktop App Unit Tests`, `Run Desktop Core Unit Tests`, `Run IDE Plugin Unit Tests`,
`Run JUnit Runner Unit Tests`, `Swift Code Coverage`. A job that moves into a reusable workflow
reports as `caller / job`, which would orphan the required context. So:

- **Composite actions are the vehicle** for any job body that is, or could become, a required check.
  The job stays in each workflow with its `name:`, `runs-on`, `needs`, `if`, `strategy`,
  `timeout-minutes` and permissions; only the `steps:` move.
- A reusable workflow is acceptable only for a job that is not a required check, and only after
  checking its context name in a pull request's checks (it changes).
- No ruleset edits, no workflow dispatches. Every slice is a pull request.

## Slices

Each slice is a small PR with a bats test that pins the shape it creates and keeps
`test/bats/pr-gate-wiring.bats` green. Required check names are asserted unchanged by comparing the
`name:` of each moved job before and after.

1. **This PR.** The report script, its bats test, and this plan.
2. **Version drift and one Bun version.** Bring `cache@v4`, `upload-artifact@v4` and `setup-java@v4`
   to the majority version, and make a bats guard fail when a workflow uses a minority version of an
   action. Single-source the Bun version (a `bun-version-file` or the composite below) instead of
   12 hard-coded copies.
3. **`setup-bun-deps` composite.** Setup Bun plus the dependency install, without the build the
   existing `setup-auto-mobile-npm-package` action also does, so lint-only jobs can use it.
4. **WHEP jobs** (`android-device-webrtc` 96%, `webrtc-integration-test` 83%): move the steps into
   composite actions; neither is a required check.
5. **Gradle jobs** (`build-android-control-proxy` 88%, `desktop-core-unit-tests` 91%,
   `junit-runner-unit-tests` 70%): composite actions, since all three are required. Starts with the
   Gradle build jobs, which the audit found differ least.
6. **`detekt`, `kotlin-code-coverage`, `node-host-integration-tests`** (40 to 64%): read the real
   differences first; the merge copy of `detekt` is pinned to the PR copy by
   `test/bats/detekt-config-cache-disabled.bats`, which shrinks once the body is shared.
7. **`bats-tests`, `installer-minimal`, `build-playground-app`:** matrix and platform gating make
   these the hardest; do them last, one per PR.
8. **`swift-code-coverage` (14%):** the two copies are different jobs under one id, not a
   duplicate; decide whether to rename one rather than share a body.

Validation after each slice: `scripts/ci/workflow-duplication-report.sh` shows the shared job's
copies down to caller-sized bodies; the sync-pinning bats tests shrink; the required context names are
unchanged.

## Outcome

Slices 2, 4 and 5 are done (#15561, #15563, #15568, #15569). The report after them:

```
job                                     A      B  shared     pct
android-device-webrtc                  11     10       9     81%
bats-tests                             89     66      48     53%
build-android-control-proxy            20     18      18     90%
build-desktop-core                     16     14      14     87%
build-ide-plugin                       16     16      14     87%
build-playground-app                   45     31      27     60%
desktop-app-unit-tests                 16     16      14     87%
desktop-core-unit-tests                37     37      34     91%
detekt                                 89     50      36     40%
ide-plugin-unit-tests                  16     17      14     82%
installer-minimal                     111     54      45     40%
junit-runner-unit-tests                20     18      18     90%
kotlin-code-coverage                   31     29      20     64%
node-host-integration-tests            38     47      27     57%
swift-code-coverage                    75     94      14     14%
webrtc-integration-test                11      9       9     81%
shared jobs: 16
```

The four jobs this lane moved to composite actions on both workflows (\`android-device-webrtc\`,
\`webrtc-integration-test\`, \`build-android-control-proxy\`, \`junit-runner-unit-tests\`) are caller-sized
now: 9 to 20 lines, the rest being the job's own gating. The shared-percentage column no longer
measures duplication for them, only that the caller wraps the same few lines.

### The rest are not duplicates

Reading the real differences for slices 6 to 8 (not for the four desktop and IDE jobs, which are
another lane's):

| Job                                   | Why sharing a body would change behaviour                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| \`detekt\`                            | The PR copy selects Android lint modules from the diff and runs \`detektMain detektTest :build-logic:test <selected lint tasks>\`; the merge copy always runs \`lintDebug\`. The two comments pin different reasons for the same config-cache setting. |
| \`node-host-integration-tests\`       | The merge copy also runs a Windows leg, unsets a wall-clock variable there and uploads a netstat capture; the PR copy runs on Linux only (Windows runs inside the Node job).                                                                           |
| \`kotlin-code-coverage\`              | A different job under the same id: the PR copy is "Run CtrlProxy Unit Tests", the merge copy is "Kotlin Code Coverage" with another task list and a 90-day coverage artifact.                                                                          |
| \`build-playground-app\`              | Disabled on merge (\`if: \${{ false }}\`); the PR copy runs more tasks and borrows a Gradle home.                                                                                                                                                      |
| \`bats-tests\`, \`installer-minimal\` | Different runners, gating, matrices and timeouts.                                                                                                                                                                                                      |
| \`swift-code-coverage\`               | A macOS job on PRs and an Ubuntu job on merge: two jobs with one id.                                                                                                                                                                                   |

Making these share a body would mean parameterizing away real differences, which risks changing what
a required check runs. They stay as they are. What does help is the guard added in #15561: the
sync-by-prose comments ("matching the PR-CI Detekt job") are the remaining risk, and
\`test/bats/detekt-config-cache-disabled.bats\` already pins the one flag that matters.

Left for the owner's call: renaming one of the two \`kotlin-code-coverage\` and \`swift-code-coverage\`
jobs, so a shared id stops implying a shared body.

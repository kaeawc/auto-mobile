# Workflow de-duplication

`pull_request.yml` and `merge.yml` define 16 job ids in common. This page states how shared job bodies
are kept in sync and which jobs stay deliberately separate.

## Measuring duplication

`scripts/ci/workflow-duplication-report.sh` prints, for each job id in both workflows, the non-comment
line counts of each copy and the percentage of the larger body's lines (order-insensitive) that
appear in both. Its bats test pins the arithmetic. For a job that calls a composite action the
percentage measures only that the callers wrap the same few lines.

## Required checks constrain the vehicle

Required status contexts live in the `green-main` ruleset and name the **job**, not the workflow.
These shared jobs are required checks: `Build CtrlProxy APK`, `Build Desktop Core Module`,
`Build IDE Plugin`, `Build Playground App`, `Installer Minimal (<os>)`, `Run CtrlProxy Unit Tests`,
`Run Desktop App Unit Tests`, `Run Desktop Core Unit Tests`, `Run IDE Plugin Unit Tests`,
`Run JUnit Runner Unit Tests`, `Swift Code Coverage`. A job moved into a reusable workflow reports as
`caller / job`, which would orphan the required context. So:

- **Composite actions are the vehicle** for any job body that is, or could become, a required check.
  The job stays in each workflow with its `name:`, `runs-on`, `needs`, `if`, `strategy`,
  `timeout-minutes` and permissions; only the `steps:` move.
- A reusable workflow is acceptable only for a job that is not a required check, and only after
  checking its context name in a pull request's checks (it changes).
- A change that moves a job body comes with a bats test pinning the new shape, keeps
  `test/bats/pr-gate-wiring.bats` green, and leaves each moved job's `name:` unchanged.

## Shared through composite actions

`build-desktop-core`, `build-ide-plugin`, `desktop-app-unit-tests`, `ide-plugin-unit-tests`,
`android-device-webrtc`, `webrtc-integration-test`, `build-android-control-proxy` and
`junit-runner-unit-tests` call composite actions from both workflows; what remains in each copy is
the job's own gating.

## Deliberately separate

These copies differ in behaviour, so sharing a body would change what a required check runs:

| Job                               | Difference                                                                                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detekt`                          | The PR copy selects Android lint modules from the diff and runs `detektMain detektTest :build-logic:test <selected lint tasks>`; the merge copy always runs `lintDebug`. The two comments pin different reasons for the same config-cache setting. |
| `node-host-integration-tests`     | The merge copy also runs a Windows leg, unsets a wall-clock variable there and uploads a netstat capture; the PR copy runs on Linux only (Windows runs inside the Node job).                                                                       |
| `kotlin-code-coverage`            | A different job under the same id: the PR copy is "Run CtrlProxy Unit Tests", the merge copy is "Kotlin Code Coverage" with another task list and a 90-day coverage artifact.                                                                      |
| `build-playground-app`            | Disabled on merge (`if: ${{ false }}`); the PR copy runs more tasks and borrows a Gradle home.                                                                                                                                                     |
| `bats-tests`, `installer-minimal` | Different runners, gating, matrices and timeouts.                                                                                                                                                                                                  |
| `swift-code-coverage`             | A macOS job on PRs and an Ubuntu job on merge: two jobs with one id.                                                                                                                                                                               |

Comments that sync copies by prose ("matching the PR-CI Detekt job") are the remaining drift risk;
`test/bats/detekt-config-cache-disabled.bats` pins the one flag that matters.

## Background

- [Workflow de-duplication audit and plan](../../devlog/2026-10-27-workflow-deduplication-audit.md)

# macOS CI capacity plan (#11010, #11011, #11012)

Status: implemented 2026-10-09; the owner steps below are still open. Owner
decisions are in issues #11010, #11011 and #11012. The earlier
[CircleCI migration plan](circleci-macos-migration.md) (#10887) has the sourced
CircleCI plan numbers.

Rule: every pull-request macOS job runs in exactly one place. Hosted
GitHub `macos-26` is the fallback for fork PRs only.

## Pools

| Pool                    | Concurrency           | Carries                                                    |
| ----------------------- | --------------------- | ---------------------------------------------------------- |
| CircleCI `m4pro.medium` | 1 macOS job at a time | PR Playground tests, all post-merge and nightly macOS work |

## CircleCI (#11010)

CircleCI runs one macOS job at a time for this organization, so it carries one PR
job and the work that is not on the PR critical path.

### Pull requests

`ios-playground-tests` is the only CircleCI job on the PR path (gated on
`run-ios`, which path filtering sets from the same paths as `filter-ios` in
`pull_request.yml`). It is advisory and must stay off the required-check list.
The CircleCI mirrors of Swift Packages, Build Xcode Projects and Build Root SPM
Package are gone; those jobs run on GitHub only.

### Post-merge

`merge.yml` schedules no macOS job. On every push to main the setup pipeline's
`detect-main-macos-changes` job diffs `HEAD~1..HEAD` against
`.circleci/main-macos-paths.txt`:

| Path group         | Paths                                                                     | CircleCI job                                              |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| `run-main-ios`     | `ios/**`, `scripts/ios/**`, `Package.swift`, SwiftFormat/SwiftLint config | Build Xcode Projects (main): generate, drift check, build |
| `run-main-desktop` | `android/desktop-app/**`, `android/desktop-core/**`                       | Build Desktop App (macos)                                 |

Both groups also match `.circleci/**`, so a config change revalidates itself.
Swift coverage keeps its existing trigger: `merge.yml`'s `swift-code-coverage` job
starts a `run-swift-coverage-main` pipeline for coverage-input changes and
downloads the badge.

**Coalescing.** Each post-merge job first runs
`scripts/ci/circleci-main-superseded.sh <group>`. If a newer main commit changes a
path in the same group, that commit's pipeline also runs the job on a tree that
contains this one, so the older job halts (green) before doing any work. The last
commit in a burst that touches the group is never superseded, so a burst of N
merges costs one run for that commit. The check fails open: if it cannot read
main, the job runs. CircleCI's project-level "auto-cancel redundant workflows" is
not used for this. It ignores the default branch, and it would cancel an iOS
run in favour of a newer pipeline that has no iOS changes.

### Nightly

`nightly.yml` schedules no hosted macOS job. A CircleCI scheduled pipeline on main
with `run-nightly-macos=true` runs the `nightly-macos` workflow, chained in this
order with `terminal` requirements so a failure never skips later jobs:

1. XCTestRunner Simulator Tests (the PR `run-ios-sim` label opt-in still uses
   `.github/workflows/xctestrunner-simulator-tests.yml`; a policy test keeps the
   selected tests and daemon budget identical)
2. Swift Packages Sweep (Xcode 26.6)
3. Build Xcode Projects Sweep (Xcode 26.6)
4. macOS Node Unit Tests
5. macOS Node Host Integration Tests
6. macOS BATS Shell Tests
7. macOS BATS Integration Tests
8. XCTestRunner Thread Sanitizer
9. Swift Packages Sweep (Xcode 26.5)
10. Build Xcode Projects Sweep (Xcode 26.5)

The Xcode 26.5 sweeps run last because every iOS PR already builds on 26.5. The
nightly sweeps build unsigned (the CircleCI executor pins signing off); the
GitHub sweeps signed when certificates were configured. Release and signing
workflows (`build-ctrl-proxy-ios-ipa`, `build-network-filter-probe`,
`build-overlay-agent`, `build-screen-capture-helper`, the desktop installers)
stay on GitHub.

## Owner steps

These need a login or a credential, so they were not done in the change.

### CircleCI (web app; do not script them against the API)

1. **Project Settings → Advanced:** confirm "Enable dynamic config using setup
   workflows" is **On** (already required).
2. **Project Settings → Triggers → Add scheduled trigger:** name `nightly-macos`,
   branch `main`, daily at 00:00 UTC (the old `nightly.yml` cron), pipeline
   parameter `run-nightly-macos` = `true` (boolean). Until this exists the nightly
   macOS jobs do not run anywhere.
3. **Project Settings → Advanced:** leave "Auto-cancel redundant workflows" as it
   is; post-merge coalescing does not rely on it (see above).
4. After the first nightly, check that the `xcode: "26.6"` image still exists
   (the sweep fails at VM start if CircleCI retires it) and that Build Desktop
   App (macos) can install JDK 21 and the Android command-line tools on the
   image. Neither has run on CircleCI yet.

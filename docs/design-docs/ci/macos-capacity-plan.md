# macOS CI capacity plan (#11010, #11011, #11012)

Status: implemented 2026-10-09; the owner steps below are still open. Owner
decisions are in issues #11010, #11011 and #11012. The earlier
[CircleCI migration plan](circleci-macos-migration.md) (#10887) has the sourced
CircleCI plan numbers.

Rule: every pull-request macOS job runs in exactly one place. Hosted
GitHub `macos-26` is the fallback for fork PRs only.

## Pools

| Pool                                   | Concurrency                            | Carries                                                    |
| -------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| CircleCI `m4pro.medium`                | 1 macOS job at a time                  | PR Playground tests, all post-merge and nightly macOS work |
| Self-hosted Mac `automobile-mac`       | N runner processes (N = 4 recommended) | Small, non-simulator PR jobs                               |
| Self-hosted Mac `automobile-mac-heavy` | exactly 1 runner process               | PR xcodebuild and simulator jobs, one at a time            |
| Namespace `auto-mobile-macos`          | 1 macOS job (trial)                    | iOS Device Capture to WHEP                                 |

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
`build-prototype-agent`, `build-screen-capture-helper`, the desktop installers)
stay on GitHub.

## Self-hosted Mac (#11011)

The owner's Mac (ARM64, 16 cores: 12 performance + 4 efficiency, 128 GiB) runs
two runner pools for owner-authored same-repository PRs. Fork PRs always use
hosted `macos-26` / `macos-latest`. Routing is the existing expression
(`github.event.pull_request.user.login == 'kaeawc'` and same repository), plus a
rollout switch, the repository variable `AUTOMOBILE_MAC_POOLS_ENABLED`, on the
jobs this change moved. Until the owner registers the runners and sets it to
`true`, those jobs keep running on hosted `macos-26`. Without the switch, a job
labelled `automobile-mac-heavy` would queue forever with no runner, and the
required `iOS Build` gate with it.

| Pool                   | Jobs                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `automobile-mac`       | SwiftLint, Swift Code Coverage, Build Desktop App (macos-latest), Installer Minimal (macos-latest), Swift Packages, Build Root SPM Package |
| `automobile-mac-heavy` | Build Xcode Projects (Playground, CtrlProxy), Prototype Simulator iOS 26, iOS Playground Tests (label-forced fallback only)                |

- The heavy pool has exactly one runner process, so xcodebuild and simulator
  jobs never overlap, and each job owns the simulators it creates. Heavy jobs
  have tight `timeout-minutes` (25, or 30 for the Playground fallback).
- The PR-time XcodeGen drift check (#10939) is the `Check XcodeGen Project
  Drift` step of Build Xcode Projects, so it runs on the heavy lane.
- Every moved job isolates `HOME`, `TMPDIR`, the XDG dirs and
  `CFFIXED_USER_HOME` under `$RUNNER_TEMP`, checks out with `clean: true`, and
  removes the isolated home at the end, like the existing self-hosted jobs.
- Xcode: hosted runners use `maxim-lobanov/setup-xcode`. Self-hosted runners use
  `scripts/ci/select-self-hosted-xcode.sh <version>`, which exports
  `DEVELOPER_DIR` for that job only, so concurrent jobs do not fight over
  `xcode-select`. It fails when the requested Xcode is missing instead of
  building on another toolchain.
- Swift Packages builds unsigned on the Mac: its signing flags are false
  whenever the job is routed there, so no certificate is imported into the
  owner's keychains.
- Cache keys of the moved jobs include `runner.environment`, so hosted and
  self-hosted runs never restore each other's SwiftPM or DerivedData state.
- Required check names are unchanged (`SwiftLint`, `Swift Code Coverage`,
  `Build Root SPM Package`, `Installer Minimal (macos-latest)`, `iOS Build`), so
  the `green-main` ruleset needs no edit.

**Exception: XCTestRunner Simulator Tests (`run-ios-sim` label).** The label
opt-in still runs on hosted `macos-26` for same-repo PRs. Its daemon steps start
an AutoMobile daemon on the default port and install gems and Homebrew packages,
which would collide with the owner's own daemon and tooling on this Mac. Moving
it needs a dedicated runner user (see owner steps) and an isolated daemon port.
It is a rare, opt-in label run, so this was left for an owner decision.

**N for the small pool: 4.** Swift package builds and the desktop Gradle build
are CPU-bound and each can use most of the cores. Four small jobs plus the heavy
lane keep about one performance core per process plus headroom for the owner's
own work. Memory (128 GiB) is not the limit. That is five runner processes in
total: the existing `mac` runner plus three new small runners, and one heavy
runner.

## Namespace macOS (#11012)

iOS Device Capture to WHEP (`ios-device-webrtc`) runs on the Namespace profile
`namespace-profile-auto-mobile-macos` for owner-authored same-repository PRs.
The Namespace trial allows one macOS job at a time (6 vCPU / 14 GB, billed at
10× the Linux rate), and WHEP fires only on WebRTC changes, so it rarely waits
for that slot. The CircleCI copy is gone.

Routing, in order:

1. Same-repo PR, `AUTOMOBILE_NAMESPACE_MACOS_ENABLED` is `true` (opt-in; set it after
   creating the profile), `NAMESPACE_RUNNERS_DISABLED` not `true` and
   `IOS_WEBRTC_HEAVY_LANE` not `true`: Namespace macOS.
2. Same-repo PR otherwise, with `AUTOMOBILE_MAC_POOLS_ENABLED=true`: the heavy
   self-hosted lane (the documented fallback, for example if ScreenCaptureKit
   cannot capture on the Namespace VM).
3. Everything else, including forks: hosted `macos-26`.

The job keeps its one capture retry for the known ScreenCaptureKit flake and has
a 30-minute timeout. On the heavy lane it isolates `HOME` like the other
self-hosted jobs, but it still starts an AutoMobile daemon and MediaMTX on fixed
ports, so use that fallback only with the heavy runner under a dedicated user.

## Job → runner, before and after

| Job                                                                            | Before (same-repo PR)                        | After (same-repo PR)                       | Fork PR        |
| ------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------ | -------------- |
| SwiftLint, Swift Code Coverage                                                 | self-hosted `automobile-mac`                 | self-hosted `automobile-mac`               | `macos-26`     |
| Build Desktop App / Installer Minimal (macOS)                                  | self-hosted `automobile-mac`                 | self-hosted `automobile-mac`               | `macos-latest` |
| Swift Packages (Xcode 26.5)                                                    | hosted `macos-26` + CircleCI mirror          | self-hosted `automobile-mac`               | `macos-26`     |
| Build Root SPM Package                                                         | hosted `macos-26` + CircleCI mirror          | self-hosted `automobile-mac`               | `macos-26`     |
| Build Xcode Projects (Playground, CtrlProxy)                                   | hosted `macos-26` + CircleCI mirror          | self-hosted `automobile-mac-heavy`         | `macos-26`     |
| Prototype Simulator iOS 26                                                     | CircleCI                                     | self-hosted `automobile-mac-heavy`         | `macos-26`     |
| iOS Playground Tests                                                           | CircleCI (GitHub `macos-26` if label-forced) | CircleCI (heavy lane if label-forced)      | CircleCI       |
| iOS Device Capture to WHEP                                                     | hosted `macos-26` + CircleCI mirror          | Namespace `auto-mobile-macos`              | `macos-26`     |
| XCTestRunner Simulator Tests (`run-ios-sim`)                                   | hosted `macos-26`                            | hosted `macos-26` (exception, see above)   | `macos-26`     |
| merge.yml: Build Desktop App (macOS), Generate/Build Xcode Projects            | dormant (`if: false`)                        | CircleCI post-merge, path-gated, coalesced | n/a            |
| nightly.yml: macOS BATS/Node, Xcode sweeps, TSan, XCTestRunner Simulator Tests | hosted `macos-latest` / `macos-26`           | CircleCI `nightly-macos`                   | n/a            |

The "After" self-hosted and Namespace placements take effect once the owner steps
below are done; until then the moved jobs run on hosted `macos-26`.

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

### Self-hosted Mac runners

Registering runners needs a registration token, so it was not done here. Run on
the Mac as the user that owns `~/actions-runner`:

1. Install Xcode 26.5 next to the current Xcode 26.6 (`/Applications/Xcode.app`)
   and Xcode 27.1 beta, for example `xcodes install 26.5`, then
   `DEVELOPER_DIR=/Applications/Xcode-26.5.0.app/Contents/Developer xcodebuild -downloadPlatform iOS`.
   `bash scripts/ci/select-self-hosted-xcode.sh 26.5` must succeed afterwards.
   Swift Packages, Build Root SPM Package, Build Xcode Projects, the Playground
   fallback and Prototype Simulator all pin 26.5.
2. Get a registration token (valid for one hour):

   ```bash
   TOKEN="$(gh api -X POST repos/kaeawc/auto-mobile/actions/runners/registration-token --jq .token)"
   ```

3. Add three small-pool runners (the existing `mac` runner, labels
   `self-hosted,macOS,ARM64,automobile-mac`, stays as the first one):

   ```bash
   for i in 2 3 4; do
     dir="$HOME/actions-runner-small-$i"
     mkdir -p "$dir" && cd "$dir"
     tar xzf "$HOME/actions-runner/actions-runner-osx-arm64-2.337.0.tar.gz"
     cp "$HOME/actions-runner/.path" "$HOME/actions-runner/.env" .
     ./config.sh --unattended --url https://github.com/kaeawc/auto-mobile \
       --token "$TOKEN" --name "mac-small-$i" --labels automobile-mac --work _work
     ./svc.sh install && ./svc.sh start
   done
   ```

4. Add exactly one heavy runner. It must have the `automobile-mac-heavy` label
   and must NOT have `automobile-mac`, otherwise small jobs could land on it and
   overlap a simulator job:

   ```bash
   dir="$HOME/actions-runner-heavy"
   mkdir -p "$dir" && cd "$dir"
   tar xzf "$HOME/actions-runner/actions-runner-osx-arm64-2.337.0.tar.gz"
   cp "$HOME/actions-runner/.path" "$HOME/actions-runner/.env" .
   ./config.sh --unattended --url https://github.com/kaeawc/auto-mobile \
     --token "$TOKEN" --name mac-heavy --labels automobile-mac-heavy --work _work
   ./svc.sh install && ./svc.sh start
   ```

   Recommended: install the heavy runner under a dedicated macOS user account
   instead, so its CoreSimulator device set, `~/Library` and launchd services
   are separate from the owner's own simulators and AutoMobile daemon. With a
   dedicated user, log in as that user once so its LaunchAgent can start.

5. Check the pools:

   ```bash
   gh api repos/kaeawc/auto-mobile/actions/runners \
     --jq '.runners[] | [.name, .status, ([.labels[].name] | join(","))] | @tsv'
   ```

   Expect `mac`, `mac-small-2..4` with `automobile-mac`, and `mac-heavy` with
   `automobile-mac-heavy`, all `online`.

6. Turn the routing on: `gh variable set AUTOMOBILE_MAC_POOLS_ENABLED --body true`.
   To fall back to hosted runners, set it to anything else.

### Namespace macOS

1. In the Namespace dashboard, create a macOS (Apple Silicon) runner profile
   named `auto-mobile-macos`, so jobs can request
   `namespace-profile-auto-mobile-macos`. Do this **before** merging: with the
   kill switch off, a same-repo WebRTC PR otherwise waits for a profile that does
   not exist.
2. Run one WebRTC PR (or add the `webrtc` label) and confirm
   `iOS Device Capture to WHEP` captures on the Namespace VM (ScreenCaptureKit
   needs a window server session; the job's simulator-window probe fails loudly
   if it is missing).
3. If it cannot capture, set `gh variable set IOS_WEBRTC_HEAVY_LANE --body true`
   (heavy self-hosted lane) and record why in #11012.
4. Check the macOS minute cost against the trial/plan on the Namespace usage page.

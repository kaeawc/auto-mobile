# macOS CI capacity plan (#11010, #11011, #11012)

Owner steps below are still open. The earlier
[CircleCI migration plan](circleci-macos-migration.md) (#10887) has the sourced CircleCI plan numbers.

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

CircleCI posts no commit status for the scheduled pipeline (#11615), so
`.github/workflows/circleci-nightly-visibility.yml` (ubuntu, daily 10:40 UTC, not a
required check) runs `scripts/ci/report-circleci-nightly.sh`. It reads the nightly
through the CircleCI API with the existing `CIRCLECI_TOKEN` secret and opens or
updates one `circleci-nightly-macos` issue naming each red job, its job URL and its
artifact names (for example `bats-unit-joblog/bats-unit-joblog-durations.tsv`).
Without the secret, or if CircleCI refuses it, the run skips with a notice.

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
rollout switch, the repository variable `AUTOMOBILE_MAC_POOLS_ENABLED`, on every
self-hosted Mac job (the four that were on the Mac before the pools gained it in
#11580). Unless it is `true`, those jobs run on hosted `macos-26` /
`macos-latest`. Without the switch, a job labelled for a pool with no online
runner queues forever, and its required check with it (#11580).

| Pool                   | Jobs                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `automobile-mac`       | SwiftLint, Swift Code Coverage, Build Desktop App (macos-latest), Installer Minimal (macos-latest), Swift Packages, Build Root SPM Package |
| `automobile-mac-heavy` | Build Xcode Projects (Playground, CtrlProxy), Prototype Simulator iOS 26, iOS Playground Tests (label-forced fallback only)                |

- Installer Minimal's macOS leg uses a Mac only when `scripts/install.sh`,
  `package.json`, `android/gradle/libs.versions.toml`, or
  `.github/workflows/pull_request.yml` changed (#11580).
  Otherwise its no-op leg reports from Linux with the same required check name.
  The minimal installer installs the published npm package but also reads the
  checkout's compileSdk TOML during the initial SDK advisory, before applying
  the preset, when adb and an SDK path are detected (including non-interactive
  mode). The main-push installer remains unconditional.
- The four PR SwiftPM build/coverage jobs cache dependencies in
  `$RUNNER_TEMP/automobile-swiftpm-cache` on the Mac, symlinked from the isolated
  home's `Library/Caches/org.swift.swiftpm`. Home cleanup removes only the link,
  leaving the directory available for the cache post-step to save (#11580).
  The cache action uses the workspace-relative literal
  `../../_temp/automobile-swiftpm-cache`: the same literal on every runner process
  shares one cache entry and must resolve to `$RUNNER_TEMP/automobile-swiftpm-cache`.
  Each isolate step warns if the directories differ, without failing the job.
  Hosted runners keep their existing two cache paths; DerivedData is unchanged.
- `Mac Runner Queue` is an advisory Linux watchdog, with a 15 minute queue-age
  threshold and 30 second polls. It waits for Fast Validation before observing
  Mac jobs on GitHub-hosted `ubuntu-latest`, which provides gh, jq, and timeout.
  It watches self-hosted jobs that exist while it runs and exits once none is
  queued. Later Prototype Simulator (`needs: ios-xcode-build`) is deliberately
  unwatched so Linux is not held for the whole Mac phase; that job is advisory
  and starts after a heavy-pool job has just run. A red result names queued jobs
  and their pools: no runner in that pool is online or the pool is saturated. Set `AUTOMOBILE_MAC_POOLS_ENABLED`
  to any value other than `true` and re-run the workflow to use hosted macOS.
  The watchdog never cancels jobs and no required gate depends on it. API errors
  remain warnings and observation is bounded to 15 minutes plus two polls; the
  job's 20 minute timeout covers it (#11580).
- The heavy pool has exactly one runner process, so xcodebuild and simulator
  jobs never overlap, and each job owns the simulators it creates. Heavy jobs
  have tight `timeout-minutes` (25, or 30 for the Playground fallback).
- Build Xcode Projects is one job that builds Playground and then CtrlProxy in
  separate named steps (#11580). As two matrix legs they ran one after the other
  on the heavy runner anyway and repeated the setup. Prototype Simulator `needs`
  that job, so the runner serves the build behind the required `iOS Build` gate
  first; it still runs whatever the build's result.
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

## Job → runner

| Job                                                                            | Same-repo PR                               | Fork PR        |
| ------------------------------------------------------------------------------ | ------------------------------------------ | -------------- |
| SwiftLint, Swift Code Coverage                                                 | self-hosted `automobile-mac`               | `macos-26`     |
| Build Desktop App / Installer Minimal (macOS)                                  | self-hosted `automobile-mac`               | `macos-latest` |
| Swift Packages (Xcode 26.5)                                                    | self-hosted `automobile-mac`               | `macos-26`     |
| Build Root SPM Package                                                         | self-hosted `automobile-mac`               | `macos-26`     |
| Build Xcode Projects (Playground, CtrlProxy)                                   | self-hosted `automobile-mac-heavy`         | `macos-26`     |
| Prototype Simulator iOS 26                                                     | self-hosted `automobile-mac-heavy`         | `macos-26`     |
| iOS Playground Tests                                                           | CircleCI (heavy lane if label-forced)      | CircleCI       |
| iOS Device Capture to WHEP                                                     | Namespace `auto-mobile-macos`              | `macos-26`     |
| XCTestRunner Simulator Tests (`run-ios-sim`)                                   | hosted `macos-26` (exception, see above)   | `macos-26`     |
| merge.yml: Build Desktop App (macOS), Generate/Build Xcode Projects            | CircleCI post-merge, path-gated, coalesced | n/a            |
| nightly.yml: macOS BATS/Node, Xcode sweeps, TSan, XCTestRunner Simulator Tests | CircleCI `nightly-macos`                   | n/a            |

Self-hosted and Namespace placements take effect once the owner steps below are done; until
then the moved jobs run on hosted `macos-26`.

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

1. Keep an Xcode 26.x installed (currently 26.6 at `/Applications/Xcode.app`,
   next to Xcode 27.1 beta) with its iOS platform
   (`xcodebuild -downloadPlatform iOS`). Swift Packages, Build Root SPM Package,
   Build Xcode Projects, the Playground fallback and Prototype Simulator request
   26.5; `bash scripts/ci/select-self-hosted-xcode.sh 26.5` uses 26.5 when
   installed and otherwise the newest installed 26.x at or above it (26.6 today),
   printing which it chose (#11422). It never selects Xcode 27.
2. Get a registration token (valid for one hour):

   ```bash
   TOKEN="$(gh api -X POST repos/kaeawc/auto-mobile/actions/runners/registration-token --jq .token)"
   ```

3. Add three small-pool runners (the existing `mac` runner, labels
   `self-hosted,macOS,ARM64,automobile-mac`, is the first). For each of `2 3 4`: make
   `$HOME/actions-runner-small-$i`, extract `$HOME/actions-runner/actions-runner-osx-arm64-<ver>.tar.gz`
   into it, copy `.path` and `.env` from `$HOME/actions-runner`, then
   `./config.sh --unattended --url https://github.com/kaeawc/auto-mobile --token "$TOKEN" --name "mac-small-$i" --labels automobile-mac --work _work`
   and `./svc.sh install && ./svc.sh start`.
4. Add exactly one heavy runner the same way (`$HOME/actions-runner-heavy`, `--name mac-heavy`,
   `--labels automobile-mac-heavy`). It must NOT carry `automobile-mac`, or small jobs could
   land on it and overlap a simulator job. Preferably install it under a dedicated macOS user so
   its CoreSimulator device set, `~/Library` and launchd services are separate from the owner's
   simulators and AutoMobile daemon; log in as that user once so its LaunchAgent can start.
5. Check the pools:

   ```bash
   gh api repos/kaeawc/auto-mobile/actions/runners \
     --jq '.runners[] | [.name, .status, ([.labels[].name] | join(","))] | @tsv'
   ```

   Expect `mac`, `mac-small-2..4` (`automobile-mac`) and `mac-heavy` (`automobile-mac-heavy`), all `online`.

6. Turn the routing on: `gh variable set AUTOMOBILE_MAC_POOLS_ENABLED --body true`.
   To fall back to hosted runners, set it to anything else
   (`gh variable set AUTOMOBILE_MAC_POOLS_ENABLED --body false`). Runs created
   after that use hosted runners for every Mac job. Jobs already queued for the
   Mac stay there until their run is cancelled, for example by a new push.

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

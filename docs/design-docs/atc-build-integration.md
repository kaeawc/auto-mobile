# atc build and test integration (research)

Status: research, nothing implemented. Researched against `rock3r/atc` v3.1.0
(commit `23934b3`, 2026-10-17) and AutoMobile `main` at `5c983ca6`.

## Goal

Let AutoMobile build apps and run their tests (Gradle, Xcode, Bazel) by depending on
[atc](https://github.com/rock3r/atc) ("Agent Traffic Control"), so builds from many
agents on one machine are serialized and resource-capped.

## Non-goals

- Replacing AutoMobile's device management. AutoMobile keeps booting, allocating,
  observing and driving emulators, simulators and phones itself through `adb`,
  `emulator`, `simctl` and `devicectl`.
- Routing AutoMobile's install, launch, tap, observe or other device ops through atc.
  atc's device op catalog is deliberately tiny (no `input`, no hierarchy, no arbitrary
  `adb shell`), so it could not replace them anyway.

## What atc is

A daemonless Node CLI (`npm install -g @rock3r/atc`, Node >= 20, zero npm
dependencies, Apache-2.0) and a stdio MCP server (`atc mcp`). All coordination goes
through a user-private `state.json` under an atomic directory lock.

It handles two domains:

| Domain  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builds  | Typed ops: `gradle.tasks`, `bazel.build/test/coverage/run/series/clean`, `xcode.build/test/buildForTesting/testWithoutBuilding/archive/clean/actions`. atc finds the wrapper, builds the literal argv (never a shell), serializes builds on the same workspace (`gradle:<root>`, `xcode:<root>`, `xcode:dd:<derivedData>`, `bazel:ws:<root>`), caps concurrent builds host-wide, checks free RAM, and caps workers (`-Dorg.gradle.workers.max`, `--jobs`, `-jobs`). |
| Devices | Leases (`atc claim/free/renew`) on emulators, simulators and phones, with boot, eviction, snapshots, a warm-affinity queue and crash recovery. Small device op set: `android.install/uninstall/launch/clearData/permission/logcat(dump)/screenshot/prop`, `ios.install/uninstall/launch/terminate/openUrl/screenshot/privacy`.                                                                                                                                      |

Useful contract details:

- Every value is validated against a strict pattern before anything runs. All
  problems come back at once as `{path, code, message, hint}` with exit `7`.
- `atc exec … --json` returns `{ok, exitCode, durationMs, steps, stdout, stderr,
  logPath?, summary?, error?, errorCode?}`. `--brief` writes the full log to disk and
  returns a condensed summary.
- `atc batch` runs a validated JSON DAG of ops (`dependsOn`, per-step `cwd`/`env`,
  scoped claims, `claim: {reuse}`), with `--validate` for a dry run that prints argv.
- Documented exit codes: `2` busy, `3` no or foreign lease, `4` queue or boot timeout,
  `5` low RAM/disk, `6` physical-device policy, `7` invalid request, `124` op timeout.
- Session identity can be set explicitly with `ATC_SESSION_ID` and `ATC_ANCHOR_PID`.
  A lease is reclaimed when its anchor PID dies.
- Device-coupled builds are detected from the request (Gradle `connected*`/`install*`
  tasks, Xcode `test`/`test-without-building` on a simulator) and require a lease.
  The leased device is injected: `ANDROID_SERIAL` or `SIMULATOR_UDID` in the child
  env (plus `ATC_DEVICE_SERIAL`/`ATC_LEASE_ID`), and `-destination id=<udid>` for Xcode.
- `ATC_STATE_DIR` relocates the state directory, which keeps tests isolated.

## What AutoMobile has today

- **No build or app-test tooling.** None of the tools in
  `schemas/tool-definitions.json` builds or runs app tests. `src/` never invokes
  `gradlew`, `am instrument` or Bazel. `xcodebuild` is only used for AutoMobile's own
  iOS CtrlProxy runner (`src/utils/ios-cmdline-tools/XcodebuildClient.ts`,
  `src/ctrlProxy/IOSCtrlProxyManager.ts`).
- **Tests are YAML plans** run by `executePlan`. The Android JUnit runner and the iOS
  XCTestRunner are run _by_ Gradle/Xcode and call back into the daemon, so the build
  tool is the outer harness and AutoMobile is called from inside it.
- **Install tolerates outside installs.** `confirmAndroidPackageInstalledLive.ts`
  re-checks the device instead of trusting a cache, so an APK installed by a Gradle
  `installDebug` task is picked up.
- **Device ownership is AutoMobile-only.** One daemon per user holds an in-memory pool
  with SQLite-backed sessions (`src/daemon/devicePool.ts`, `sessionManager.ts`).
  Daemons coordinate through per-device claim files
  (`src/daemon/foreignDeviceOwnership.ts`) and a shared Android boot admission
  registry (`src/features/bootAdmission/sharedBootAdmissionGates.ts`). The iOS boot
  gate is in-process only.
- **Optional host tools** are probed in the `automobile:host/toolchain` resource
  (`src/server/hostToolchainResources.ts`) and in doctor checks
  (`src/doctor/checks/`). External CLIs are spawned argv-first through
  `HostCommandExecutor`, with `FakeHostCommandExecutor` for tests, and lint guards
  enforce those boundaries (`test/lint/hostShellBoundary.test.ts` and friends).

## How the two fit

Builds are a clean gap: atc adds something AutoMobile lacks and overlaps nothing.
Devices are the problem: both tools lease devices, and neither can see the other's
leases.

| Concern                                                                      | Owner                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Compile, assemble, `build-for-testing`, Bazel targets                        | atc                                                               |
| Serializing builds per workspace, host build slots, RAM admission            | atc                                                               |
| Device boot, shutdown, allocation, sessions                                  | AutoMobile (unchanged)                                            |
| Install, launch, terminate, observe, interact                                | AutoMobile (unchanged)                                            |
| Device-coupled test tasks (`connected*AndroidTest`, `test-without-building`) | atc runs the build tool, on a device AutoMobile already allocated |

## The lease conflict

atc decides a device is occupied only from its own `state.json` (`getOccupyingLease`
in atc's `cli.mjs`). An emulator AutoMobile booted and is driving looks **idle** to atc.
With the default config, another agent's `atc claim` can then:

1. **Hand it out** as a warm idle match (Tier 0), so two agents drive one device.
2. **Shut it down** to free a slot for a cold boot (Tier 2 eviction,
   `autoStopIdleOnContention: true` by default).

The reverse also holds: AutoMobile only honours AutoMobile claim files, so it would
allocate a device that an atc lease holds.

Capacity is double-counted too. atc defaults to `maxRunningEmulators: 2` and
`maxRunningSimulators: 4` and counts running emulators. AutoMobile computes its own
limit from RAM and CPU. Each can boot past the other's cap.

Any integration that touches devices needs a bridge. A build-only integration does
not.

## Options

### A. Build-only (no device): recommended first step

AutoMobile exposes typed build ops that call `atc exec gradle tasks`, `atc exec xcode
build-for-testing`, `atc exec bazel build` and so on, each marked `buildOnly` so atc
refuses anything that would claim a device.

- No device conflict at all.
- Covers assembling APKs and test APKs, `build-for-testing`, Bazel builds and
  host-side unit tests (`testDebugUnitTest`, `bazel test`). The AutoMobile JUnit runner
  is a host-side unit test from atc's point of view, so it fits here too. It acquires
  its own AutoMobile device session through the daemon as it does today.
- Install and launch stay on AutoMobile's existing `installApp`/`launchApp`.

### B. Lease mirroring: needed for device-coupled tests

To run `connectedDebugAndroidTest` or `test-without-building` through atc on a device
AutoMobile owns, AutoMobile registers its ownership with atc:

- **AutoMobile to atc.** When the daemon assigns a device to a session, run
  `atc claim --serial <serial>` (or `--udid`) with `--wait 0 --json`,
  `ATC_SESSION_ID=automobile-<sessionUuid>` and `ATC_ANCHOR_PID=<daemon pid>`. Renew
  on the existing session heartbeat (atc's default TTL is 600 s, max 3600 s). On
  release, run `atc free <serial>`, never with `--stop`, because AutoMobile owns
  shutdown. Device-coupled build ops then run under the same session id, so atc
  injects the right serial.
- **atc to AutoMobile.** Add an `AtcForeignDeviceOwnership` implementing the
  existing `ForeignDeviceOwnership` interface, composed with the claim-file
  implementation. It reports devices leased by non-AutoMobile atc sessions as foreign,
  so the pool refuses them with the existing retryable `device_owned_by_other_daemon`.
- **Capacity.** At minimum, document setting atc's `maxRunningEmulators` and
  AutoMobile's `AUTOMOBILE_ANDROID_MAX_BOOTED` consistently. A better fix counts atc
  `starting` leases as admissions.

Open risks with B:

- `atc status --json` runs full fleet discovery (`adb devices`, `emulator list`,
  `simctl list`, `devicectl list`) on every call. That is too slow to run on every
  pool refresh. We need a cheap read-only lease listing from atc, or we would have to
  read `state.json` directly, which is a private format.
- A mirrored lease still leaves the device open to Tier 2 eviction if the lease lapses
  (daemon stall past the TTL). Setting `autoStopIdleOnContention false` closes that,
  but it is a host-wide setting that changes atc's behaviour for every agent.
- `atc claim --serial` on a running emulator should be a Tier 0 warm match with no
  reset, but this needs to be confirmed by a spike, including how it treats an
  emulator whose AVD it can't map.

### C. Let atc boot, AutoMobile adopts (rejected)

atc boots and leases, and AutoMobile drives whatever serial atc hands back. This
removes the conflict by making atc the device owner, which replaces AutoMobile's
device management. It is out of scope by the non-goals above.

## How AutoMobile would call atc

**Spawn the `atc` CLI, not the npm package as a library.** The package's only export
is its CLI module, so there is no stable library API to import. It targets Node >= 20,
while AutoMobile runs on Bun. The CLI's `--json` output and exit codes are its
documented contract.

- New `AtcClient` interface plus a default implementation over `HostCommandExecutor`
  (argv only, no shell), and a `FakeAtcClient` for unit tests. Follow the
  `XcodebuildClient` pattern and add it to the host-spawn boundary allowlists.
- Optional dependency: resolve `atc` from `PATH`, with an env override (for example
  `AUTOMOBILE_ATC_PATH`, registered in `src/config/env.ts` and documented in
  `docs/using/environment-variables.md`). Check `atc --version` against a supported
  range.
- Add an `atc` row to `automobile:host/toolchain` and a doctor check that warns, not
  fails, when atc is missing, with the install command as the recommendation.
- Build tools are hidden or return an actionable error (install atc) when atc is
  absent. Everything else in AutoMobile keeps working without it.

## Possible MCP tool surface

Kept small to avoid tool-count bloat:

| Tool                | Maps to                                                                          | Notes                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`             | `gradle.tasks`, `xcode.build`/`buildForTesting`/`archive`, `bazel.build`         | `buildOnly: true` in option A. Returns status, duration, the log path and the brief summary, plus artifact paths where they can be found (APK under `build/outputs/apk`, `.app` under DerivedData).                          |
| `runTests`          | `gradle.tasks` (`test*`/`connected*`), `xcode.testWithoutBuilding`, `bazel.test` | Device-coupled variants need option B and bind to the caller's AutoMobile session device. atc does not parse test results, so AutoMobile parses JUnit XML or `.xcresult` and could record them in `testExecutionRepository`. |
| `buildPlan` (maybe) | `atc batch`                                                                      | Only if multi-step builds prove common. A plan can use `--validate` for a dry run.                                                                                                                                           |

## Gaps to raise upstream with atc

1. A cheap read-only lease listing without fleet probes, for option B.
2. A way to register external ownership: a lease that atc never boots, stops, resets
   or evicts, or a per-device "not mine, never touch" marker. That is safer than
   turning off `autoStopIdleOnContention` host-wide.
3. `android.instrument`, already listed in atc's scope as a candidate, for running
   instrumentation without Gradle.
4. Test result locations in exec results (JUnit XML dir, `.xcresult` path).
5. A versioned `--json` schema, so AutoMobile can check compatibility rather than
   parse best-effort.

## Risks

- atc is young: a single maintainer, v3.0 broke the 2.x interface, and the JSON
  output shape is not formally versioned. Pin a supported version range and keep the
  integration behind the `AtcClient` seam.
- Strict validation will refuse some real-world task names, schemes or paths.
  `--force --reason` exists for build values; AutoMobile should surface the
  rejection hints rather than retry with force on its own.
- Raw `./gradlew` or `xcodebuild` run outside atc is not coordinated, so the benefit
  depends on agents using the AutoMobile tool rather than their shell.

## Suggested phases

1. **Spike.** Install atc in a scratch state dir (`ATC_STATE_DIR`) and confirm the
   `exec --json` and `batch --json` shapes, Windows behaviour, and `claim --serial` on
   an emulator AutoMobile booted (no reset, no reboot).
2. **Option A.** `AtcClient`, toolchain and doctor entries, and a build-only `build`
   tool. No device interaction.
3. **Option B.** Lease mirroring and `AtcForeignDeviceOwnership`, then device-coupled
   `runTests`. Gated on the upstream lease-listing ask, or on accepting a slower
   refresh path.
4. **Upstream asks** filed with atc in parallel with phase 2.

## Open questions

- Should device-coupled tests ever be in scope, or is build-only plus AutoMobile's
  existing `installApp`/`executePlan` enough?
- Should AutoMobile mirror leases into atc only when atc is installed, or always
  coordinate with it when its state directory exists?
- Is a host-wide `autoStopIdleOnContention false` acceptable on machines that run
  AutoMobile, until atc supports external ownership?

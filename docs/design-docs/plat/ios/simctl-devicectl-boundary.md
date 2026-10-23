# iOS simctl and devicectl boundary

## Summary and decision

One `IosDeviceBackend` interface covers simulator and physical-device branches (Planned #8348).
Physical devices use `devicectl`. Simulators use `simctl` wherever it supports the operation, and
`devicectl` only for capabilities that exist only there. Exactly one command-line tool owns each
simulator concern. There is no CoreDevice-version gate in the current code; the production probe is lazy
and injectable (#8354) with no simulator-command consumer yet.

Capability claims are from #8347 (Xcode 27.1 beta, CoreDevice 651.13.4), not re-verified in this
checkout.

## Capability matrix

| Group                               | Capabilities (per #8347)                                                                                                                                                             | Current code                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both tools, booted simulator        | List, install/uninstall, list apps, launch, open URL, screenshot, pasteboard, location, appearance, content size, status bar, reboot                                                 | Discovery via `simctl` (`SimCtlClient.ts`) and `devicectl` (`DevicectlDeviceLister.ts`, `discoverySource.ts`). Install/uninstall/launch/`OpenURL.ts` branch simulator vs physical. Location/appearance via `simctl` (`DeviceState.ts`). iOS clipboard uses CtrlProxy (`Clipboard.ts`); screenshots use the capture paths. |
| devicectl-only                      | Orientation; per-display info with `active`; per-display screenshots; read-only Duo hinge angle; VoiceOver, biometrics; `--json-output`                                              | Simulator use Planned (#8349, #8350, #8351). Display inventory comes from `simctl io ... enumerate` (`SimulatorDisplays.ts`); biometric enrollment via `simctl spawn` + `notifyutil` (`notifyutil.ts`); VoiceOver via CtrlProxy (`CtrlProxyVoiceOver.ts`).                                                                |
| simctl-only                         | Boot, bootstatus, shutdown, create, clone, erase, delete; custom device sets (`--set`); video; privacy, keychain reset, push, addmedia, spawn, app container, terminate by bundle ID | Implemented in `SimCtlClient.ts`, `IosSimulatorPermissions.ts`, `ResetKeychain.ts`, `iosAppContainer.ts`, `TerminateApp.ts`; video via `HybridVideoCaptureBackend.ts`. Physical-device termination uses `devicectl`.                                                                                                      |
| devicectl unsupported on simulators | File copy and `info files`; lock state, profiles, notification post, sysdiagnose; terminate by PID                                                                                   | Reported gaps; no simulator code path for them.                                                                                                                                                                                                                                                                           |

## Current code map

- `SimCtlClient.ts`: simulator discovery, lifecycle, app ops, push, appearance, display enumeration.
- `DevicectlDeviceLister.ts`: lists connected physical devices; classifies simulator records and drops
  them at the lister boundary (simctl stays the simulator source of truth). `DeviceAppManager.ts`: physical
  app operations. `discoverySource.ts` keeps the two sources separate; `DeviceDetection.ts` identifies iOS
  IDs for routing.
- `InstallApp`, `UninstallApp`, `LaunchApp`, `TerminateApp`, `OpenURL`, `ClearAppData` branch simulator
  (`simctl`) vs physical (`devicectl`). `IosPhysicalVideoCaptureBackend.ts` documents that `devicectl` has
  no screen recording. Availability checks (`DevicectlDeviceLister.ts`, `hostToolchainResources.ts`) report
  devicectl presence, not CoreDevice version.

**Devicectl listing classification.** A listing needs a recognized successful envelope to be complete. A
simulator record needs an iOS/iPadOS platform, `reality: "simulated"` (or, only when reality is absent,
`visibilityClass: "simulators"`) and a simulator-shaped hardware UDID (as in both captures under
`test/fixtures/ios-devicectl/`); the same evidence is required before filtering a simulator as not booted
or unreachable. Watch/TV/Vision platforms are excluded explicitly; unknown platforms or conflicting/missing
kind evidence are unidentified; explicit physical reality with simulator visibility is contradictory
(unidentified before platform exclusion). Top-level visibility beats `properties.state.visibilityClass`;
no other visibility value is interpreted. Unidentifiable records (including non-objects) are skipped
without making discovery incomplete, logged once per changed set at debug with fixed labels only. Only an
invocation failure, unreadable JSON or a non-success/failure envelope makes discovery incomplete with a
typed error and replays the bounded last-good physical inventory, so the idle-device reaper doesn't infer
a disconnect.

**Current deviation.** The proposed simulator pasteboard owner is `simctl`, but iOS clipboard actions use
CtrlProxy; none call devicectl. No simulator path calling devicectl for a simctl-owned concern exists.

## Ownership rules

- One tool per concern on simulators. Pasteboard belongs to `simctl`: after `devicectl pasteboard copy`,
  `simctl pbcopy` exits successfully but leaves the value unchanged (#8347).
- Simulator lifecycle, privacy, keychain reset, push, addmedia, spawn, app-container access and app
  termination stay on `simctl`.
- `devicectl` for physical devices; on simulators only for capabilities `simctl` lacks, and only after the
  installed CoreDevice supports them. Simulator paths must check availability and capability presence before
  a state-dependent devicectl-only operation (probe: #8354).

## Known devicectl gaps on simulators

Per #8347: file copy and `device info files` unsupported; `device process terminate --pid` fails with
"No such process" (CoreDevice 27.0, 27.1, iOS 18.6); `launch --console` blocks until exit;
`device info apps` needs `--include-all-apps`; negative coordinates need `--longitude=-122.4` syntax;
lock state, profiles, notification post and sysdiagnose unsupported.

Per #8623 (2026-10-01, devicectl 651.13.4, no physical device; not hardware-verified):

- Shut-down simulators support `list devices`, `device info details` and `ddiServices` (static
  properties, 7 capabilities). `info apps/processes/displays/appearance/voiceover` fail with CoreDeviceError
  1001 ("capability ... is not supported by this device"); `info lockState` fails 1001 even when booted.
  Shutdown adds the `com.apple.dt.coredevice.device.boot` capability, so capability presence is a pre-check.
- devicectl listed 8 of simctl's 18 simulators. The 10 missing were default-named, never-booted iOS 27.0
  devices, yet a freshly created never-booted one appeared; the visibility rule is undetermined. Custom
  device-set invisibility is per #8347.

**Inventory state and failures.**

- `bootState` values: `shutdown`, `booting`, `booted`, `shuttingDown` (connection `disconnected` while
  booting/shutting down; simctl says "Shutting Down"). The parser compares case-insensitively and returns
  typed not-available reasons `shutdown`, `booting`, `shutting-down`, `not-booted` (unknown/missing);
  booted simulators also need a connected state, else `unreachable`. These keep discovery complete.
- Failed commands still write JSON with `info.outcome: "failed"` and an `error` object (domain/code, nested
  `NSUnderlyingError`), then exit 1. CoreDevice codes 1000 (device not found) and 1001 (capability
  unsupported) differ from "could not run". The lister attaches `coreDeviceError` on parsed failure
  envelopes (even after non-zero exit), recognizing 1000/1001 only when the domain contains "CoreDevice"
  (case-insensitive; exact string unverified); others are kind `other`. Real failed-envelope captures are
  owed.
- Address devices by UDID, never name: duplicate simulator names yielded 1000, not 1001 or an ambiguity
  error.
- `--json-output -` writes stdout here, but the lister keeps its temp file (older CoreDevice unverified;
  `DeviceAppManager` uses files too) until a minimum supported version is set.
- Physical-record shapes under `properties.*` (including whether `identifier` differs from the UDID) are
  unverified; physical availability stays lenient and simulator boot-state observations don't establish
  physical rules.

## CoreDevice gating

Devicectl-only simulator features require CoreDevice >= 651. Gate on the installed CoreDevice, not the
Xcode version: `xcrun devicectl` / `xcrun simctl` are shims into system-wide CoreDevice and CoreSimulator
frameworks under `/Library/Developer/PrivateFrameworks`, and `DEVELOPER_DIR` does not select them. An older
Xcode's devicectl shim with a newer installed CoreDevice can trigger `xcodebuild -runFirstLaunch` (a
CoreDevice downgrade hazard; the guard is out of scope per the owner, 2026-10-02, and not reported).

Wired (#8354): a lazy process-owned `devicectl --version` probe and bounded memoization of unsupported
feature identifiers (`1001`) scoped by simulator type/runtime. Boot state is checked before simulator
capability invocations; diagnostics keep the bounded devicectl availability/version read, seed the probe
and report bounded simctl boot-state counts; capability commands stay lazy. No current tool calls the probe,
so none is gated on CoreDevice version. Say "requires CoreDevice >= 651", not "Xcode 27+".

Apple documents devicectl for physical and simulated devices and says to start simulators with simctl or
Device Hub first; simctl is not deprecated, and Xcode 27 adds `reboot` to both (#8347). On older
CoreDevice, continue through `simctl`; only devicectl-only features report unsupported. CI stays on Xcode
26.5 and covers the simctl path.

## Guardrails

`test/lint/simctlDevicectlBoundary.test.ts` parses TypeScript and fails when simulator-scoped code directly
routes a covered simctl-owned concern to devicectl. Simulator scope = simulator-named code, simulator-specific
files, explicit simulator branches and simulator-UDID arguments. Covered: pasteboard, lifecycle verbs,
privacy, keychain reset, push, addmedia, spawn, app-container access, process termination, and the
app-termination owner API. It deliberately allows generic physical-device calls (including
`device process terminate --pid`) unless simulator scope is clear, and allows devicectl for explicitly
devicectl-only capabilities through the boot-first probe. Scope inferred only from runtime values,
dynamically assembled argv or wrapper indirection stays Planned (#8353).

## Out of scope

Moving VoiceOver or biometrics from CtrlProxy / `notifyutil` to devicectl, unless a need appears (#8347).

Epic: #8347. Sub-issues: #8348, #8354, #8349, #8350, #8351, #8353. Related: #6372, #8246, #8254, #8343,
#8320.

# iOS simctl and devicectl boundary

One `IosDeviceBackend` interface covers simulator and physical-device branches (#8348). Physical
devices use `devicectl`. Simulators use `simctl` wherever it supports the operation, and `devicectl`
only for capabilities that exist only there. Exactly one command-line tool owns each simulator
concern. No current tool is gated on CoreDevice version; the probe (#8354) is lazy, injectable and
has no simulator-command consumer yet.

Capability claims come from #8347 (Xcode 27.1 beta, CoreDevice 651.13.4).

## Capability matrix

| Group                               | Capabilities (per #8347)                                                                                                                                                             | Current code                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both tools, booted simulator        | List, install/uninstall, list apps, launch, open URL, screenshot, pasteboard, location, appearance, content size, status bar, reboot                                                 | Discovery via `simctl` (`SimCtlClient.ts`) and `devicectl` (`DevicectlDeviceLister.ts`, `discoverySource.ts`). Install/uninstall/launch/`OpenURL.ts` branch simulator vs physical. Location/appearance via `simctl` (`DeviceState.ts`). iOS clipboard uses CtrlProxy (`Clipboard.ts`); screenshots use the capture paths. |
| devicectl-only                      | Orientation; per-display info with `active`; per-display screenshots; read-only Duo hinge angle; VoiceOver, biometrics; `--json-output`                                              | No simulator use (#8349, #8350, #8351). Display inventory comes from `simctl io ... enumerate` (`SimulatorDisplays.ts`); biometric enrollment via `simctl spawn` + `notifyutil` (`notifyutil.ts`); VoiceOver via CtrlProxy (`CtrlProxyVoiceOver.ts`).                                                                     |
| simctl-only                         | Boot, bootstatus, shutdown, create, clone, erase, delete; custom device sets (`--set`); video; privacy, keychain reset, push, addmedia, spawn, app container, terminate by bundle ID | Implemented in `SimCtlClient.ts`, `IosSimulatorPermissions.ts`, `ResetKeychain.ts`, `iosAppContainer.ts`, `TerminateApp.ts`; video via `HybridVideoCaptureBackend.ts`. Physical-device termination uses `devicectl`.                                                                                                      |
| devicectl unsupported on simulators | File copy and `info files`; lock state, profiles, notification post, sysdiagnose; terminate by PID                                                                                   | No simulator code path.                                                                                                                                                                                                                                                                                                   |

## Code map

- `SimCtlClient.ts`: simulator discovery, lifecycle, app ops, push, appearance, display enumeration.
- `DevicectlDeviceLister.ts`: lists connected physical devices; classifies simulator records and
  drops them (simctl stays the simulator source of truth). `DeviceAppManager.ts`: physical app
  operations. `discoverySource.ts` keeps the two sources separate; `DeviceDetection.ts` identifies
  iOS IDs for routing.
- `InstallApp`, `UninstallApp`, `LaunchApp`, `TerminateApp`, `OpenURL`, `ClearAppData` branch
  simulator (`simctl`) vs physical (`devicectl`). `IosPhysicalVideoCaptureBackend.ts` notes that
  `devicectl` has no screen recording. Availability checks (`DevicectlDeviceLister.ts`,
  `hostToolchainResources.ts`) report devicectl presence, not CoreDevice version.
- iOS clipboard actions use CtrlProxy, although `simctl` is the designated simulator pasteboard
  owner; nothing calls devicectl for a simctl-owned concern.

## Devicectl listing classification

- A listing is complete only with a recognized successful envelope.
- A simulator record needs an iOS/iPadOS platform, `reality: "simulated"` (or, only when reality is
  absent, `visibilityClass: "simulators"`) and a simulator-shaped hardware UDID (see the captures in
  `test/fixtures/ios-devicectl/`). The same evidence is required before filtering a simulator as not
  booted or unreachable.
- Watch/TV/Vision platforms are excluded. Unknown platforms or conflicting/missing kind evidence are
  unidentified. Explicit physical reality with simulator visibility is contradictory (unidentified,
  checked before platform exclusion).
- Top-level visibility beats `properties.state.visibilityClass`; no other visibility value is
  interpreted.
- Unidentifiable records (including non-objects) are skipped without making discovery incomplete,
  logged once per changed set at debug with fixed labels only.
- Only an invocation failure, unreadable JSON or a non-success/failure envelope makes discovery
  incomplete: it returns a typed error and replays the bounded last-good physical inventory, so the
  idle-device reaper does not infer a disconnect.

## Ownership rules

- One tool per concern on simulators. Pasteboard belongs to `simctl`: after
  `devicectl pasteboard copy`, `simctl pbcopy` exits successfully but leaves the value unchanged
  (#8347).
- Simulator lifecycle, privacy, keychain reset, push, addmedia, spawn, app-container access and app
  termination stay on `simctl`.
- `devicectl` serves physical devices; on simulators only for capabilities `simctl` lacks, and only
  once the installed CoreDevice supports them. Simulator paths check availability and capability
  presence before a state-dependent devicectl-only operation (probe: #8354).

## Devicectl on simulators: gaps and behavior

- Unsupported: file copy and `device info files`; lock state, profiles, notification post,
  sysdiagnose. `device process terminate --pid` fails with "No such process" (CoreDevice 27.0, 27.1,
  iOS 18.6). `launch --console` blocks until exit. `device info apps` needs `--include-all-apps`.
  Negative coordinates need `--longitude=-122.4` syntax (#8347).
- Shut-down simulators support only `list devices`, `device info details` and `ddiServices`.
  `info apps/processes/displays/appearance/voiceover` fail with CoreDeviceError 1001 ("capability ...
  is not supported by this device"); `info lockState` fails 1001 even when booted. Shutdown adds the
  `com.apple.dt.coredevice.device.boot` capability, so capability presence is a pre-check (#8623).
- devicectl does not list every simctl simulator (custom device sets are invisible, #8347); the rule
  for default sets is undetermined.
- Address devices by UDID, never name: duplicate simulator names yield 1000, not 1001 or an
  ambiguity error.

### Inventory state and failures

- `bootState` values: `shutdown`, `booting`, `booted`, `shuttingDown` (connection `disconnected`
  while booting/shutting down). The parser compares case-insensitively and returns typed
  not-available reasons `shutdown`, `booting`, `shutting-down`, `not-booted` (unknown/missing);
  booted simulators also need a connected state, else `unreachable`. These keep discovery complete.
- Failed commands still write JSON with `info.outcome: "failed"` and an `error` object
  (domain/code, nested `NSUnderlyingError`), then exit 1. CoreDevice codes 1000 (device not found)
  and 1001 (capability unsupported) differ from "could not run". The lister attaches
  `coreDeviceError` on parsed failure envelopes (even after non-zero exit), recognizing 1000/1001
  only when the domain contains "CoreDevice" (case-insensitive); others are kind `other`.
- The lister writes `--json-output` to a temp file (as `DeviceAppManager` does) until a minimum
  supported CoreDevice version is set, though `--json-output -` writes stdout on current CoreDevice.
- Physical-record shapes under `properties.*` (including whether `identifier` differs from the
  UDID) are unverified, so physical availability stays lenient; simulator boot-state rules do not
  apply to physical devices.

## CoreDevice gating

Devicectl-only simulator features require CoreDevice >= 651. Gate on the installed CoreDevice, not
the Xcode version: `xcrun devicectl` / `xcrun simctl` are shims into system-wide CoreDevice and
CoreSimulator frameworks under `/Library/Developer/PrivateFrameworks`, and `DEVELOPER_DIR` does not
select them. Say "requires CoreDevice >= 651", not "Xcode 27+".

An older Xcode's devicectl shim with a newer installed CoreDevice can trigger
`xcodebuild -runFirstLaunch`, a CoreDevice downgrade hazard. There is no guard and it is not
reported.

The probe (#8354) is a lazy, process-owned `devicectl --version` call plus bounded memoization of
unsupported feature identifiers (`1001`) scoped by simulator type/runtime. Boot state is checked
before simulator capability invocations. Diagnostics keep the bounded devicectl availability/version
read, seed the probe and report bounded simctl boot-state counts; capability commands stay lazy.

Apple documents devicectl for physical and simulated devices and says to start simulators with
simctl or Device Hub first; simctl is not deprecated, and Xcode 27 adds `reboot` to both (#8347). On
older CoreDevice, everything goes through `simctl`; only devicectl-only features report unsupported.
CI stays on Xcode 26.5 and covers the simctl path.

## Guardrails

`test/lint/simctlDevicectlBoundary.test.ts` parses TypeScript and fails when simulator-scoped code
routes a covered simctl-owned concern to devicectl.

- Simulator scope: simulator-named code, simulator-specific files, explicit simulator branches and
  simulator-UDID arguments.
- Covered: pasteboard, lifecycle verbs, privacy, keychain reset, push, addmedia, spawn,
  app-container access, process termination, and the app-termination owner API.
- Allowed: generic physical-device calls (including `device process terminate --pid`) unless
  simulator scope is clear, and devicectl for explicitly devicectl-only capabilities through the
  boot-first probe.
- Not detected: scope inferred only from runtime values, dynamically assembled argv or wrapper
  indirection (#8353).

## Out of scope

Moving VoiceOver or biometrics from CtrlProxy / `notifyutil` to devicectl (#8347).

Epic: #8347. Sub-issues: #8348, #8354, #8349, #8350, #8351, #8353. Related: #6372, #8246, #8254,
#8343, #8320.

## Background

- [devicectl simulator probe findings](../../../devlog/2026-10-02-simctl-devicectl-boundary-probe-findings.md)

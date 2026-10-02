# iOS simctl and devicectl boundary

## Summary and decision

Use one `IosDeviceBackend` interface for simulator and physical-device branches (Planned #8348). Physical-device operations use `devicectl`. Simulator operations use `simctl` wherever it supports the operation, and use `devicectl` only for capabilities that exist only there. Keep one command-line tool as the owner of each simulator concern. The current implementation has no CoreDevice-version gate; the production probe is lazy and injectable (#8354), with no current simulator-command consumer.

The capability and behavior details in this document are per #8347, tested there with Xcode 27.1 beta and CoreDevice 651.13.4. They are evidence from that issue, not a claim that this checkout has re-verified them.

## Capability matrix

The tool capability claims below are per #8347. “Current code status” describes this checkout.

| Group                               | Capabilities                                                                                                                                                                                           | Current code status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both tools on a booted simulator    | List devices, install and uninstall apps, list apps, launch apps, open URLs, screenshots, pasteboard, set location, appearance and content size, status bar, reboot.                                   | The code discovers simulators through `simctl` and physical devices through `devicectl` (`SimCtlClient.ts`, `DevicectlDeviceLister.ts`, `discoverySource.ts`). App install, uninstall, list and launch paths branch by simulator versus physical device (`InstallApp.ts`, `UninstallApp.ts`, `LaunchApp.ts`). URL opening branches the same way (`OpenURL.ts`). Simulator state changes such as location and appearance use `simctl` (`DeviceState.ts`, `SimCtlClient.ts`). iOS clipboard currently uses CtrlProxy (`Clipboard.ts`), and screenshots use the observation/capture paths rather than a devicectl simulator path (`CtrlProxyScreenshot.ts`, `HybridVideoCaptureBackend.ts`). |
| devicectl-only                      | Read/set/rotate orientation; per-display information with an `active` flag; per-display screenshots; read-only Duo hinge angle; VoiceOver, biometrics; `--json-output` on every command.               | Simulator use of these devicectl capabilities is Planned (#8349, #8350, #8351). The current simulator display inventory comes from `simctl io ... enumerate` (`SimCtlClient.ts`, `SimulatorDisplays.ts`). Simulator biometric enrollment uses `simctl spawn` with `notifyutil` (`DeviceState.ts`, `notifyutil.ts`); VoiceOver has existing CtrlProxy paths (`CtrlProxyVoiceOver.ts`).                                                                                                                                                                                                                                                                                                     |
| simctl-only                         | Boot, bootstatus, shutdown, create, clone, erase, delete; custom device sets (`--set`); video recording; privacy, keychain reset, push, addmedia, spawn, app container access, terminate by bundle ID. | Simulator lifecycle and simulator commands are implemented through `SimCtlClient.ts`. Privacy and keychain reset use simctl (`IosSimulatorPermissions.ts`, `ResetKeychain.ts`). Push and app container helpers use simctl (`SimCtlClient.ts`, `iosAppContainer.ts`). Simulator termination uses simctl (`TerminateApp.ts`). Simulator video uses the platform capture backend (`HybridVideoCaptureBackend.ts`, `PlatformVideoCaptureBackend.ts`). Physical-device app termination uses `devicectl` (`TerminateApp.ts`).                                                                                                                                                                   |
| devicectl unsupported on simulators | File copy and `info files`; lock state, profiles, notification post, sysdiagnose; process termination by PID.                                                                                          | These are reported gaps per #8347. No simulator code path for these devicectl operations was found in the inspected current code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Current code map

`SimCtlClient.ts` is the simulator command runner and implements simulator discovery, lifecycle, app operations, push, appearance, and simulator display enumeration. `DevicectlDeviceLister.ts` classifies simulator records and drops them at the lister boundary; simctl remains the simulator source of truth. It lists connected physical devices; `DeviceAppManager.ts` implements physical-device app operations. `discoverySource.ts` keeps simulator and physical-device discovery as separate sources, and `DeviceDetection.ts` identifies iOS device IDs for routing.

A devicectl listing requires a recognized successful envelope to be complete.
Simulator records require an iOS/iPadOS platform, `reality: "simulated"` (or, only
when reality is absent, `visibilityClass: "simulators"`), and a
simulator-shaped hardware UDID, as present in both captured listings under
`test/fixtures/ios-devicectl/`. The same evidence is required before filtering a
simulator as not booted or unreachable. Known Watch/TV/Vision platforms are
excluded explicitly; unknown platforms or conflicting/missing simulator kind
evidence are unidentified. Explicit physical reality combined with simulator
visibility is contradictory and unidentified before platform exclusion; top-level
visibility takes precedence
over `properties.state.visibilityClass`, and no other visibility value is interpreted.
Unidentifiable records, including non-object entries, are skipped: they contribute
no device and do not make discovery incomplete. Skips log once per changed set at
debug, using only fixed labels without device identifiers or names. Only an
invocation failure, unreadable JSON, or a non-success/failure envelope makes
discovery incomplete with a typed error and replays the bounded last-good physical
inventory, keeping the idle-device reaper from inferring a disconnect.

`InstallApp.ts`, `UninstallApp.ts`, `LaunchApp.ts`, `TerminateApp.ts`, `OpenURL.ts`, and `ClearAppData.ts` branch between simulator `simctl` operations and physical-device `devicectl` operations where applicable. Simulator app-container lookup is in `iosAppContainer.ts`. Simulator privacy and keychain operations are in `IosSimulatorPermissions.ts` and `ResetKeychain.ts`.

`DeviceState.ts` routes simulator location and appearance operations through `SimCtlClient.ts`; its simulator biometric path uses `notifyutil.ts` through `simctl spawn`. `HybridVideoCaptureBackend.ts` selects simulator recording and physical-device capture paths. `IosPhysicalVideoCaptureBackend.ts` documents that `devicectl` has no screen-recording operation. iOS clipboard currently routes through `IOSCtrlProxyClient` in `Clipboard.ts`. Host-tool availability checks in `DevicectlDeviceLister.ts` and `hostToolchainResources.ts` report whether devicectl is available; they do not probe CoreDevice version for feature gating.

### Current deviations

The proposed simulator pasteboard owner is `simctl`, but current iOS clipboard actions use CtrlProxy (`Clipboard.ts`). They do not call devicectl. No simulator path calling devicectl for a simctl-owned concern was found in the inspected files. The source-scan test in `test/lint/simctlDevicectlBoundary.test.ts` guards direct devicectl commands by parsing TypeScript calls and treating simulator-named code, simulator-specific files, explicit simulator branches, and simulator-UDID arguments as simulator scope. It covers pasteboard, lifecycle verbs, privacy, keychain reset, push, addmedia, spawn, app-container commands, and process termination; it also recognizes the app-termination owner API in simulator scope. The scan does not infer simulator scope from arbitrary runtime values or follow dynamically assembled commands and unrelated wrappers. Those cases remain Planned (#8353).

## Ownership rules

- On simulators, use one tool per concern. Pasteboard belongs to `simctl`; do not mix a devicectl pasteboard write with simctl clipboard commands. Per #8347, after `devicectl pasteboard copy`, `simctl pbcopy` exits successfully but leaves the value unchanged.
- Keep simulator lifecycle, privacy, keychain reset, push, addmedia, spawn, app-container access, and app termination on `simctl`.
- Use `devicectl` for physical-device operations. On simulators, use it only for capabilities unavailable through `simctl` and only after the installed CoreDevice version supports them.
- Keep one `IosDeviceBackend` interface for the simulator-versus-physical-device choice (Planned #8348).

## Known devicectl gaps on simulators

The following behaviors are per #8347:

- File copy and `device info files` are unsupported.
- `device process terminate --pid` fails with “No such process” on CoreDevice 27.0, 27.1, and iOS 18.6.
- Per #8623 findings (2026-10-01, devicectl 651.13.4, no physical device), shut-down
  simulators support `list devices`, `device info details`, and `device info ddiServices`
  (static properties, 7 capabilities). `device info apps/processes/displays/appearance/voiceover`
  fail with CoreDeviceError 1001, "capability … is not supported by this device".
  `device info lockState` fails with 1001 even when booted. Shutdown adds the
  `com.apple.dt.coredevice.device.boot` capability; capability presence is a pre-check.
- Per the same #8623 findings, devicectl listed 8 of simctl's 18 simulators. The 10
  missing were default-named, never-booted iOS 27.0 devices, but a freshly created
  never-booted simulator did appear. The visibility rule is undetermined; simctl
  stays the simulator source of truth. Custom-device-set invisibility is per #8347.
- `launch --console` blocks until the app exits.
- `device info apps` needs `--include-all-apps` to include all apps.
- Negative coordinates need `--longitude=-122.4` syntax.
- Lock state, profiles, notification post, and sysdiagnose are unsupported.

Simulator paths must check availability and capability presence before issuing a
state-dependent devicectl-only operation. That operation probe is Planned (#8354).

### Inventory state and command failures

The following are per #8623 findings, probed 2026-10-01 on devicectl 651.13.4
with no physical device; they are not newly verified hardware behavior:

- Simulator `bootState` values include `shutdown`, `booting`, `booted`, and
  `shuttingDown`. Connection is `disconnected` while booting/shutting down;
  simctl calls the latter "Shutting Down". The parser compares boot states
  case-insensitively and returns typed not-available reasons `shutdown`, `booting`,
  `shutting-down`, or `not-booted` for unknown/missing states. Booted simulators
  also need a connected state; otherwise their reason is `unreachable`. These
  recognized unavailable records keep discovery complete.
- Failed commands still write JSON with `info.outcome: "failed"`, an `error`
  object with domain/code and nested `NSUnderlyingError`, then exit 1. CoreDevice
  codes 1000 (device not found) and 1001 (capability unsupported) are distinct
  from "could not run". The lister attaches `coreDeviceError` on parsed failure
  envelopes, including after a non-zero exit. It recognizes 1000/1001 only when
  the domain contains "CoreDevice" (case-insensitive; its exact string is
  unverified). Other domains/codes have kind `other`; timeout/unavailable
  invocation failures keep their existing meaning. Real failed-envelope captures
  are still owed.
- Address devices by UDID, never by name: duplicate simulator names yielded 1000
  rather than 1001 or an ambiguity error.
- `--json-output -` writes stdout on this version. The lister keeps its temp file
  because older CoreDevice versions are unverified and DeviceAppManager uses
  files too; changing this awaits a minimum supported version.
- Physical-record shapes under `properties.*`, including whether `identifier`
  differs from the UDID, remain unverified. Physical availability stays lenient;
  simulator boot-state observations do not establish physical-device rules.

## CoreDevice gating

The devicectl-only simulator features in this design require CoreDevice >= 651. Gate on the installed CoreDevice version, not the selected Xcode version. Per #8347, `xcrun devicectl` and `xcrun simctl` are shims into system-wide CoreDevice and CoreSimulator frameworks under `/Library/Developer/PrivateFrameworks`; `DEVELOPER_DIR` does not select the framework version. An older Xcode's devicectl shim with a newer installed CoreDevice can trigger `xcodebuild -runFirstLaunch`, with a CoreDevice downgrade hazard.

A lazy process-owned `devicectl --version` probe and bounded memoization of unsupported feature identifiers (`1001`), scoped by simulator type/runtime, are wired (#8354). Boot state is checked before simulator capability invocations; diagnostics retain the bounded devicectl availability/version read, seed the probe, and report bounded simctl boot-state counts. Capability commands remain lazy. The production downgrade guard remains unconfigured pending version measurements. No current tool calls the probe, so no current tool is gated on CoreDevice version. Use the label “requires CoreDevice >= 651”; do not describe this as “Xcode 27+”.

Apple documents devicectl for physical and simulated devices and says to start simulators with simctl or Device Hub first. simctl is not deprecated; Xcode 27 release notes add `reboot` to both tools. These documentation points are per #8347.

## Older toolchains

On older installed CoreDevice versions, continue simulator operations through `simctl`. Only devicectl-only simulator features should report unsupported. CI remains on Xcode 26.5 and covers the simctl path (per #8347).

## Guardrails

`test/lint/simctlDevicectlBoundary.test.ts` fails when structurally simulator-scoped TypeScript directly routes a covered simctl-owned concern to devicectl. It recognizes simulator-specific paths and names, explicit simulator branches, and simulator-UDID arguments. Covered concerns are pasteboard, lifecycle verbs, privacy, keychain reset, push, addmedia, spawn, app-container access, and process termination; it also checks the app-termination owner API in simulator scope. It deliberately allows generic physical-device calls, including `device process terminate --pid`, unless simulator scope is clear. Simulator scope inferred only from runtime values, dynamically assembled argv, and arbitrary wrapper/API indirection remain Planned (#8353). The guard allows devicectl for explicitly devicectl-only simulator capabilities through the boot-first CoreDevice probe (#8354); production simulator command consumers remain planned.

## Out of scope

Moving VoiceOver or biometrics from CtrlProxy and `notifyutil` paths to devicectl is out of scope unless a need appears (per #8347).

## Related issues

Epic: #8347. Sub-issues: #8348, #8354, #8349, #8350, #8351, #8353. Related: #6372, #8246, #8254, #8343, #8320.

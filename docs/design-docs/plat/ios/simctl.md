# simctl Integration

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd> <kbd>📱 Simulator Only</kbd>

> **Current state:** `simctl` integration is fully implemented for simulator lifecycle, app management, device discovery, and demo mode. macOS only. See the [Status Glossary](../../status-glossary.md) for chip definitions.

AutoMobile uses `simctl` for iOS simulator lifecycle and app management. This layer is
responsible for booting simulators, installing apps, launching processes, and controlling
system-level simulator behaviors.

## Responsibilities

- Simulator lifecycle: boot, shutdown, erase.
- App lifecycle: install, uninstall, launch, terminate.
- Device discovery and capability reporting.
- Status bar configuration (demo mode) when supported.
- Live locale and localization changes (see below).
- Biometric (Touch ID / Face ID) simulation for `biometricAuth` (see below).
- Simulated push delivery for `postNotification` (see below).
- Deep-link / URL-scheme discovery from the installed `.app` bundle (see below).
- Per-app notification authorization read via BulletinBoard (see below).
- Device settings capture/restore for `deviceSnapshot` (see below).

## App lifecycle: simulators vs physical devices

<kbd>✅ Implemented</kbd>

`launchApp`, `terminateApp`, `installApp`, and `uninstallApp` pick their transport
from the target's UDID form (`isIosSimulatorUdid`): the 8-4-4-4-12 UUID means a
**simulator** (`simctl`); anything else (e.g. the `00008XXX-…` form) means a
**physical device** (`devicectl`, macOS + iOS 17+).

For `launchApp` specifically:

- **Simulator** — `xcrun simctl launch` / `terminate` (unchanged). On cold boot the app is terminated first because `simctl launch` does not terminate an already-running instance.
- **Physical device** — `xcrun devicectl device process launch --device <udid> --terminate-existing --json-output <file> --quiet <bundle-id>`; the launched PID is read from `result.process.processIdentifier` in the JSON output. `--terminate-existing` is the **authoritative cold-boot relaunch**: it terminates any already-running instance and starts a fresh process (which foregrounds). `devicectl` has no foreground-if-running verb, so a warm launch also relaunches this way. The device path therefore issues **no separate pre-terminate** — that would be a redundant round-trip.
- **No standalone devicectl terminate _within launch_.** `launchApp` relies on `--terminate-existing` for its cold-boot relaunch rather than a separate pre-terminate round-trip. The standalone `terminateApp` tool does implement a device terminate (see below).
- **`clearAppData` on a device** — wipes the sandbox via `devicectl` uninstall+reinstall (`clearAppDataViaReinstall`) before relaunching; a failed clear aborts the launch rather than launching with stale data.

For `terminateApp` specifically:

- **Simulator** — `xcrun simctl terminate <udid> <bundle-id>`; a "found nothing to terminate" error is treated as `wasRunning: false` rather than a failure.
- **Physical device** — `devicectl` has no terminate-by-bundle-id verb, so termination is a **three-step** operation (`DeviceAppManager.terminateApp`): resolve the bundle path, find the running PID, then kill it —
  1. Resolve the on-device bundle path via `xcrun devicectl device info apps --device <udid> --bundle-id <id> --json-output <file> --quiet`. No matching bundle → `{ wasInstalled: false, wasRunning: false }` (no terminate issued).
  2. Enumerate running processes via `xcrun devicectl device info processes --device <udid> --json-output <file> --quiet` and match the process whose executable path lives **inside** the resolved bundle directory (the app's own main binary, a direct child of `<bundle>.app/` — nested `PlugIns/*.appex/*` extensions are excluded). No match → `{ wasInstalled: true, wasRunning: false }`.
  3. Force-kill the matched PID with the dedicated verb: `xcrun devicectl device process terminate --device <udid> --pid <pid> --kill --quiet` → `{ wasInstalled: true, wasRunning: true }`. `--kill` sends SIGKILL (uncatchable), matching Android `am force-stop` semantics; the bare verb would send a catchable SIGTERM.
  - **Already-exited race (#3054).** The resolved PID can exit on its own between step 2 and the kill; devicectl then returns non-zero (ESRCH / "No such process") and the promisified `exec` rejects. `isDevicectlProcessGoneError` recognizes that text and treats it as `{ wasInstalled: true, wasRunning: true }` (the app was running and is now gone) instead of a false `success: false`, mirroring the simulator's "found nothing to terminate" tolerance. Any other terminate failure (device locked, not connected) still propagates.
  - **JSON field-name caveat.** The `device info processes` envelope is **not formally documented by Apple**; `findRunningProcessPid` deep-walks it and accepts several spellings (executable as a string or `{ url | path }`; PID as `processIdentifier` / `pid` / `processID`). A basename fallback matches when the process path root differs from the `info apps` bundle URL (e.g. `/var` vs `/private/var` symlink). Pin the real field names against captured device output when possible.
  - **iOS ≤16 / non-macOS** — `devicectl` process management requires iOS 17+ on a macOS host; unsupported combinations surface as a clear, non-crashing `success: false` error (thrown by `DeviceAppManager.terminateApp`, mapped to a result by `TerminateApp`) rather than a silent `success: true` no-op.

## Live locale changes

<kbd>✅ Implemented</kbd>

The `changeLocalization` MCP tool supports live locale changes on iOS simulators using
`simctl` plus `defaults`. Physical iOS device system configuration is not supported.

### How it works

1. **Write simulator settings** via `xcrun simctl spawn <udid> defaults write`:
   - `AppleLocale` — the ICU locale identifier (underscored form, e.g. `ja_JP`).
   - `AppleLanguages` — an ordered array of BCP 47 tags built from the requested
     locale (e.g. `["ja-JP", "ja"]`), so UI strings resolve correctly.
   - `AppleTimeZone`, `AppleICUForce24HourTime`, `AppleCalendar` — for the
     remaining localization axes.
2. **Read-back verification** — every write is read back and compared to the expected
   value; a mismatch is reported as an error.
3. **SpringBoard restart** — `launchctl stop com.apple.SpringBoard` inside the
   simulator causes SpringBoard to re-launch and adopt the new preferences. The server
   polls `launchctl list com.apple.SpringBoard` (up to 10 retries, 500 ms apart) to
   confirm it is back.
4. **Darwin notification** — `notifyutil -p com.apple.language.changed` tells
   in-process observers that the locale has changed.
5. **Optional app restart** — the `restartApp` parameter accepts a bundle ID. When
   provided, the server terminates the app with `xcrun simctl terminate` and
   relaunches it with `xcrun simctl launch`, so the app picks up the new locale
   (running apps cache locale at launch). The bundle ID is validated against a strict
   reverse-DNS pattern to prevent shell injection.

### MCP tool parameters (iOS-specific)

| Parameter        | Description                                                               |
| ---------------- | ------------------------------------------------------------------------- |
| `locale`         | Locale tag, e.g. `ar-SA`, `ja-JP`                                         |
| `timeZone`       | IANA zone ID, e.g. `Asia/Tokyo`                                           |
| `timeFormat`     | `"12"` or `"24"`                                                          |
| `calendarSystem` | e.g. `gregory`, `japanese`, `buddhist`                                    |
| `restartApp`     | Bundle ID of an app to terminate and relaunch after the change (iOS only) |

### Limitations

- Physical iOS device system configuration is not supported.
- Text direction (`textDirection` parameter) is not applicable on iOS — RTL layout is
  driven by the app's language; set an RTL locale instead.
- Running apps cache locale at launch. Use the `restartApp` parameter or manually
  relaunch the app for it to pick up new settings.

## Biometric simulation

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd> <kbd>📱 Simulator Only</kbd>

The `biometricAuth` MCP tool and `setDeviceState` control Touch ID / Face ID state
on simulators through BiometricKit Darwin notifications via
`xcrun simctl spawn <udid> notifyutil`. This reaches parity with the Android emulator
`adb emu finger` path (see [Android biometrics](../android/biometrics.md)) for
`match` / `fail`.

Before provisioning, call `getIosSimulatorCapabilities` with a device type and runtime
from `automobile:devices/images`. It reports the versioned capability identifiers
`biometrics.enrollment`, `biometrics.match`, `biometrics.fail`, `biometrics.cancel`,
and `biometrics.error`. Enrollment is supported; match/fail require an enrolled state;
cancel/error are explicitly unsupported on iOS Simulator.

The catalog lists every CoreSimulator device type and runtime, including watchOS
and tvOS entries that have no BiometricKit at all, so the report first validates
the selected pair and returns it as `selection: { valid, reason? }`. Only an
iPhone or iPad device type on an iOS runtime is valid; anything else — a mismatched
pair, a non-iOS runtime, or an unrecognized identifier — reports every biometric
capability as `unsupported` with the reason, rather than advertising a contract the
simulator cannot honor.

Restoration on release is verified, and a failed restore is retried while the
device stays quarantined, so a simulator never returns to the idle pool holding
session-modified enrollment.

### How it works

1. **Set enrollment** — `setDeviceState` accepts
   `biometrics: { enrollment: "enrolled" | "not_enrolled" }`; `biometricAuth`
   also accepts `action: "enroll" | "unenroll"` for iOS Simulator. Each uses a
   registered `notifyutil` set/read/post on
   `com.apple.BiometricKit.enrollmentChanged`.
   Apple `notifyutil(1)` documents that state values require a current
   registration; the helper self-registers so enrollment does not depend on
   BiometricKit already owning the key. Empirical iOS 18.6 simulator checks
   showed this specific BiometricKit key also persisted without explicit `-1`,
   but the shared helper keeps the registration for keys without an external
   owner.
   When enrollment is changed in a daemon session, the original enrollment is
   restored before that session releases the simulator.
2. **Match / non-match** — `biometricAuth` first verifies that biometry is
   enrolled, then posts the key the app's `LAContext` is waiting on:
   - Touch ID: `com.apple.BiometricKit_Sim.fingerTouch.match` / `…nomatch`
   - Face ID: `com.apple.BiometricKit_Sim.pearl.match` / `…nomatch`

   `modality: "any"` posts both pairs; the simulator's non-enrolled biometry is a no-op,
   so the action works regardless of the device's biometry type.

### Action mapping

| MCP `action`       | iOS result                                    |
| ------------------ | --------------------------------------------- |
| `enroll`           | set enrollment to `enrolled`                  |
| `unenroll`         | set enrollment to `not_enrolled`              |
| `match`            | verify enrolled state, then post `*.match`    |
| `fail`             | verify enrolled state, then post `*.nomatch`  |
| `cancel` / `error` | `supported: "partial"` — no simctl equivalent |

### Limitations

- Simulator only. Physical iOS devices have no public biometric-injection API and return
  `supported: false`.
- `match` and `fail` never force enrollment. Configure the state first so tests can
  deterministically cover both enrolled and not-enrolled flows.
- `cancel` / `error` cannot be injected — the notifications carry only match vs non-match.
  On Android these use the `AutoMobileBiometrics` SDK override, which has no iOS counterpart.

## Push notifications

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd> <kbd>📱 Simulator Only</kbd>

The `postNotification` MCP tool delivers a simulated remote push to a target app on a
booted simulator via `xcrun simctl push <udid> <bundleId> <payload.apns>`. Unlike Android
(a local notification posted by the in-app SDK; see
[Android notifications](../android/notifications.md)), this is an OS-routed simulated push
that needs no AutoMobile iOS SDK — but it does require an explicit `appId` (bundle id).

### How it works

1. Build an APNs payload: `title` / `body` → `aps.alert`, `channelId` → `aps.category`,
   plus a top-level `"Simulator Target Bundle": <appId>`.
2. Reject payloads larger than the 4096-byte `simctl push` limit.
3. Write the payload to a temp `.apns` file and run `simctl push` (the simctl command
   layer has no stdin, so a file is used rather than `-`).

### Limitations

- Simulator only. `simctl push` cannot target physical devices (no APNs token/server);
  physical iOS devices return `supported: false`.
- `appId` is required on iOS — there is no frontmost-bundle resolution like the Android
  dumpsys path.
- Rich media is limited: `bigPicture` / `imagePath` (needs a Notification Service Extension)
  and `actions` (need a pre-registered `UNNotificationCategory`) are ignored with a
  `warning` rather than failing.

## Deep-link discovery

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd> <kbd>📱 Simulator Only</kbd>

The `getDeepLinks` MCP tool returns an iOS app's declared deep links. iOS apps declare
deep links statically in bundle metadata rather than via a runtime resolver, so AutoMobile
reads them off the installed `.app` bundle on disk. Custom URL schemes and universal-link
hosts come from two different sources.

### How it works

1. **Resolve the bundle path** — `xcrun simctl get_app_container <udid> <bundleId> app`
   returns the `.app`'s host filesystem path. A missing app exits non-zero and is reported
   as a clean "not installed" result.
2. **URL schemes** — read `<app>/Info.plist` with host `plutil -convert json` and collect
   `CFBundleURLTypes[].CFBundleURLSchemes[]` (deduplicated). These become the `schemes`
   field.
3. **Universal-link hosts** — `codesign -d --entitlements :- <app> | plutil -convert json`
   surfaces the code-signing entitlements; AutoMobile keeps
   `com.apple.developer.associated-domains` entries prefixed with `applinks:` and strips the
   prefix. These become the `hosts` field. Unsigned bundles or bundles without associated
   domains yield `[]`, not an error.
4. **Document types** — best-effort `supportedMimeTypes` from
   `CFBundleDocumentTypes[].LSItemContentTypes[]`.
5. **Cross-platform shape** — synthesized `intentFilters` (one VIEW filter listing each
   scheme/host) keep the `DeepLinkResult` shape identical to Android so platform-agnostic
   callers work unchanged.

`get_app_container` routes through `simctl`; `plutil`/`codesign` are host tools (not
`simctl` subcommands) and run directly on the host filesystem.

### Limitations

- Simulator only. Physical-device discovery (copying the device-signed bundle off-device
  via `devicectl`) returns an explicit "not yet implemented" error.
- iOS has no runtime intent resolver, so only _declared_ schemes/domains are reported.
- `supportedMimeTypes` is best-effort document-type metadata, not a routing guarantee.

## Notification authorization read

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd> <kbd>📱 Simulator Only</kbd>

The `getNotificationPolicy` MCP tool reports per-app notification authorization
(`UNAuthorizationStatus`) on iOS simulators by reading the BulletinBoard daemon's on-disk
section info. There is no host-side runtime API for this, so AutoMobile decodes the
persisted plist.

### How it works

1. **Locate the plist** —
   `~/Library/Developer/CoreSimulator/Devices/<udid>/data/Library/BulletinBoard/VersionedSectionInfo.plist`.
2. **Decode the outer plist** — convert it with `plutil -convert xml1` (not `json`: the
   file embeds `<data>` blobs JSON cannot represent) and extract the base64 `<data>` blob
   registered under `sectionInfo[<bundleId>]`.
3. **Decode the nested blob** — each section value is a separate `bplist00`
   NSKeyedArchiver archive. Because it contains `CFKeyedArchiverUID` refs that
   `plutil -convert json` rejects, AutoMobile writes the blob to a temp file and converts
   it with `plutil -convert xml1`, then reads the settings dict scalars
   (`authorizationStatus`, `alertType`, `lockScreenSetting`, `notificationCenterSetting`,
   `pushSettings`).
4. **Map the status** — `authorizationStatus` maps to
   `notDetermined`/`denied`/`authorized`/`provisional`/`ephemeral`; `allowed` is true for
   any delivery-capable status — `authorized` (2), `provisional` (3, quiet delivery) and
   `ephemeral` (4, App Clips). Callers needing strict full authorization check
   `authorizationStatus === "authorized"`. The result uses `method: "ios_bulletinboard_plist"`.

An app with no registered section returns `allowed: null` plus a warning (the app likely
never requested authorization), not an error. A missing/unreadable plist returns a warning
rather than throwing.

### Limitations

- Simulator only. Physical devices return `supported: false` (no host-side read API;
  notification settings are only available to the owning app at runtime via
  `UNUserNotificationCenter`).
- Read-only. `setNotificationPolicy` stays unsupported on iOS: there is no public API
  to write per-app notification authorization, and editing the BulletinBoard plist on
  disk would not take effect without restarting the daemon.
- This is per-app _authorization status_, a different concept from Android's DND
  _policy access_ — see [Notifications](../android/notifications.md).

## Device settings snapshot

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd> <kbd>📱 Simulator Only</kbd>

When `deviceSnapshot` is invoked with `includeSettings: true` on an iOS simulator,
AutoMobile captures and restores a curated allowlist of simulator settings alongside app
data. (Previously iOS silently dropped settings and hard-coded the manifest to
`includeSettings: false`.)

### How it works

1. **Capture per-key defaults** — for each `(domain, key)` in the allowlist, run
   `xcrun simctl spawn <udid> defaults read <domain> <key>` and record the value. The
   allowlist is scalar-only for now (`{.GlobalPreferences, AppleLocale}`); array-typed keys
   such as `AppleLanguages` are a follow-up because a plain per-key `defaults write` cannot
   round-trip them.
2. **Capture UI state** — `xcrun simctl ui <udid> appearance` and `... content_size` read
   the device-level light/dark appearance and Dynamic Type size.
3. **Persist to the manifest** — captured values go into a distinct optional
   `iosSettings` manifest field (separate from Android's `global/secure/system` triplet,
   which does not fit `(domain, key)` exports).
4. **Restore surgically** — on restore (gated on `manifest.includeSettings &&
manifest.iosSettings`, identical to Android), each value is re-applied with a per-key
   `defaults write` (never a whole-domain `defaults import`, so system-managed keys are not
   clobbered), then `simctl ui appearance`/`content_size` re-apply UI state so it takes
   effect without a respawn.

Individual key read/write failures are logged and skipped (non-fatal), matching the
per-package resilience of iOS app-data restore.

### Limitations

- Simulator only; physical-device settings are not reachable via `simctl`.
- Scalar keys only in the first cut; array-typed and per-app domains are future work.
- `simctl spawn ... defaults` has no stdin, so whole-domain `defaults export/import` is not
  used — the per-key allowlist is the deliberate, auditable design.

## Do Not Disturb (setDeviceState)

<kbd>✅ Implemented</kbd> <kbd>📱 Simulator (iOS ≤17) Only</kbd>

The `setDeviceState` / `getDeviceState` MCP tools control Do Not Disturb. On iOS,
DND is **simulator-only and binary** (on/off) when the legacy notification path
can prove it works — this is a hard platform limitation, not a missing wiring
detail. Known **iOS 18+ simulators skip the legacy write probe and report
`capability: "unsupported"`** (see below): DND moved to the private
`donotdisturbd` Focus daemon. Unknown or older simulator runtimes attempt the
legacy path, but write success is behavior-based and requires an independent
fresh-process readback.

### How it works (iOS ≤17 simulators)

1. **Binary toggle** — the only lever the simulator exposes is the
   `com.apple.donotdisturb.enabled` Darwin notification, driven via
   `xcrun simctl spawn <udid> notifyutil`. All four flags are passed in a
   **single combined invocation** — `notifyutil -1 <key> -s <key> <0|1> -g <key> -p <key>`
   (`iosNotifyutilRegisteredSetReadPostCommand` in `src/utils/ios-cmdline-tools/notifyutil.ts`),
   not four separate shell calls:
   - `notifyutil -1 com.apple.donotdisturb.enabled ...` creates a temporary
     registration so the state variable exists even if no other process already
     owns the key.
   - `notifyutil -s com.apple.donotdisturb.enabled <0|1>` sets the value while
     that registration is alive.
   - `notifyutil -g com.apple.donotdisturb.enabled` reads the state in the same
     invocation.
   - `notifyutil -p com.apple.donotdisturb.enabled` posts it so observers react.
   - After a short settle, a separate fresh-process
     `notifyutil -g com.apple.donotdisturb.enabled` verifies that the value
     persisted. Only this independent readback can make the write
     `verified: true`.
2. **Honest capability reporting** — every result carries a machine-readable
   `capability` field so callers can branch instead of string-matching warnings:
   - `binary` — simulator legacy path verified: on/off only.
   - `unsupported` — physical device, known **iOS 18+ simulator**, or a legacy
     write whose independent readback reverted instead of persisting.
   - (`full` is reserved for Android, where all four `zen_mode` tiers are
     distinct, persisted, and verified.)
3. **No silent downgrade** — a `priority` or `alarms` request applies plain DND
   and reports it honestly: `requestedMode: "priority"|"alarms"`,
   `appliedMode: "none"`, a structured `warning`, and `verified: false` (so
   `success` is `false`). The tool never claims a tier it cannot deliver.
4. **Best effort with behavior verification** — results are `bestEffort: true`.
   The same-invocation registered set/read/post proves only that the command
   could set state while its registration existed; it is not authoritative by
   itself. The setter only reports success when the independent readback
   observes the requested binary state.

### Limitations

- **Known iOS 18+ simulators: unsupported fast-path.** iOS 18 moved Do Not Disturb / Focus to the
  private **`donotdisturbd`** daemon (a Core Data store + Focus-assertion model).
  That daemon owns the legacy `com.apple.donotdisturb.enabled` notification and
  immediately resets it to its authoritative value — verified empirically, a
  `notifyutil -s` write reads back `0` from a fresh process even sub-second later
  (an unmanaged notify key set the same way persists). So the legacy key neither
  reflects nor controls the real Focus state: writes cannot verify and reads are a
  confident falsehood. When the simulator's iOS major version is known from device
  metadata or `simctl list devices <udid> --json`, iOS 18+ is treated as an
  unsupported fast-path to avoid a known-dead probe. When the version is unknown
  or expected to support the legacy path, `setDeviceState` still probes behavior:
  if the fresh-process readback reverts, the result is `capability:
"unsupported"` instead of a false success. On unknown runtimes, an off request
  reading back disabled is not enough to prove capability, because reclaimed
  runtimes also settle to `0`; positive enable persistence is the useful proof.
  Apple exposes no public API to read or set Focus/DND. Use an iOS 17 or earlier
  simulator with verified legacy behavior, or set it manually / via a Shortcuts
  automation.
- **Simulator only.** Physical iOS devices return `supported: false`,
  `capability: "unsupported"`, and a specific error: iOS exposes **no public
  API** to enable/disable Focus or Do Not Disturb (only the read-only Focus
  Filter API), and Apple's device tooling (`devicectl`, XCUITest) ships no
  DND/Focus setter.
- **Binary, not per-mode.** Since iOS 15, DND lives inside the private **Focus**
  framework. There is no per-mode (priority vs. alarms-only) Darwin notification
  analogous to Android's `zen_mode` integer, so iOS cannot be mapped to the
  Android four-mode model.
- **No cosmetic fallback.** `simctl status_bar override` exposes
  `time`/`dataNetwork`/`wifi*`/`cellular*`/`battery*`/`operatorName` — no DND
  flag — so even a status-bar-only indicator is unavailable.

## Usage patterns

- Prefer deterministic simulator selection by device identifier.
- Keep simulator state consistent between runs (reset/erase when needed).
- Use dedicated simulators for parallel test execution.

## Limitations

- macOS only (requires Xcode Command Line Tools).
- Simulator-only; physical devices are out of scope for simctl.

## See also

- [CtrlProxy iOS](xctestrunner/index.md) - Touch injection and element queries.
- [iOS overview](index.md)
- [Android biometrics](../android/biometrics.md) - The `biometricAuth` Android counterpart.
- [Android notifications](../android/notifications.md) - The `postNotification` Android counterpart,
  and the cross-platform notification policy concept (Android DND policy access vs iOS
  per-app authorization).

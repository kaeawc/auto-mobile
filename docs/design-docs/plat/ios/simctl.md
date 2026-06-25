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

## Live locale changes

<kbd>✅ Implemented</kbd>

The `changeLocalization` MCP tool supports live locale changes on iOS simulators without
requiring a manual reboot. When a locale, time zone, time format, calendar system, or
language is changed, the server applies the settings and then forces the simulator UI to
pick them up immediately.

### How it works

1. **Write settings** via `xcrun simctl spawn <udid> defaults write`:
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

| Parameter | Description |
|-----------|-------------|
| `locale` | Locale tag, e.g. `ar-SA`, `ja-JP` |
| `timeZone` | IANA zone ID, e.g. `Asia/Tokyo` |
| `timeFormat` | `"12"` or `"24"` |
| `calendarSystem` | e.g. `gregory`, `japanese`, `buddhist` |
| `restartApp` | Bundle ID of an app to terminate and relaunch after the change (iOS only) |

### Limitations

- Simulator only; physical devices are not supported for locale changes.
- Text direction (`textDirection` parameter) is not applicable on iOS — RTL layout is
  driven by the app's language; set an RTL locale instead.
- Running apps cache locale at launch. Use the `restartApp` parameter or manually
  relaunch the app for it to pick up new settings.

## Biometric simulation

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd> <kbd>📱 Simulator Only</kbd>

The `biometricAuth` MCP tool simulates Touch ID / Face ID on simulators by posting
BiometricKit Darwin notifications inside the simulator via
`xcrun simctl spawn <udid> notifyutil`. This reaches parity with the Android emulator
`adb emu finger` path (see [Android biometrics](../android/biometrics.md)) for
`match` / `fail`.

### How it works

1. **Enroll** — `notifyutil -s com.apple.BiometricKit.enrollmentChanged 1` then
   `-p com.apple.BiometricKit.enrollmentChanged` ensures a biometry is enrolled.
2. **Match / non-match** — post the key the app's `LAContext` is waiting on:
   - Touch ID: `com.apple.BiometricKit_Sim.fingerTouch.match` / `…nomatch`
   - Face ID: `com.apple.BiometricKit_Sim.pearl.match` / `…nomatch`

   `modality: "any"` posts both pairs; the simulator's non-enrolled biometry is a no-op,
   so the action works regardless of the device's biometry type.

### Action mapping

| MCP `action` | iOS result |
|--------------|------------|
| `match` | post `*.match` |
| `fail` | post `*.nomatch` |
| `cancel` / `error` | `supported: "partial"` — no simctl equivalent |

### Limitations

- Simulator only. Physical iOS devices have no public biometric-injection API and return
  `supported: false`.
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
- iOS has no runtime intent resolver, so only *declared* schemes/domains are reported.
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
   `notDetermined`/`denied`/`authorized`/`provisional`/`ephemeral`; `allowed` is true only
   for `authorized` (2). The result uses `method: "ios_bulletinboard_plist"`.

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
- This is per-app *authorization status*, a different concept from Android's DND
  *policy access* — see [Notifications](../android/notifications.md).

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

<kbd>✅ Implemented</kbd> <kbd>📱 Simulator Only</kbd>

The `setDeviceState` / `getDeviceState` MCP tools control Do Not Disturb. On iOS,
DND is **simulator-only and binary** (on/off) — this is a hard platform
limitation, not a missing wiring detail.

### How it works

1. **Binary toggle** — the only lever the simulator exposes is the
   `com.apple.donotdisturb.enabled` Darwin notification, driven via
   `xcrun simctl spawn <udid> notifyutil`:
   - `notifyutil -s com.apple.donotdisturb.enabled <0|1>` sets the value.
   - `notifyutil -p com.apple.donotdisturb.enabled` posts it so observers react.
   - `notifyutil -g com.apple.donotdisturb.enabled` reads it back.
2. **Honest capability reporting** — every result carries a machine-readable
   `capability` field so callers can branch instead of string-matching warnings:
   - `binary` — simulator: on/off only.
   - `unsupported` — physical device: DND cannot be set at all.
   - (`full` is reserved for Android, where all four `zen_mode` tiers are
     distinct, persisted, and verified.)
3. **No silent downgrade** — a `priority` or `alarms` request applies plain DND
   and reports it honestly: `requestedMode: "priority"|"alarms"`,
   `appliedMode: "none"`, a structured `warning`, and `verified: false` (so
   `success` is `false`). The tool never claims a tier it cannot deliver.
4. **Best effort** — results are `bestEffort: true`. `notifyutil` values are
   session-scoped, so a separate `-g` read may not reflect a prior `-s`; the
   readback is advisory, not authoritative.

### Limitations

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

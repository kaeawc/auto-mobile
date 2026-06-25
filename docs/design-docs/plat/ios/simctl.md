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
- [Android notifications](../android/notifications.md) - The `postNotification` Android counterpart.

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

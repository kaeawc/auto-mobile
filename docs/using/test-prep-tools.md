# Test prep tools

Prepare a repeatable device and app state before running a flow. These tools
are useful for fixtures, localization, permissions, and system state.

## App files and picker fixtures

Use `putAppFile` to write text, base64, or a host file into an app container:

```json
{
  "name": "putAppFile",
  "arguments": {
    "platform": "android",
    "appId": "com.example.app",
    "container": "documents",
    "destinationPath": "fixtures/settings.json",
    "contentText": "{\"enabled\":true}"
  }
}
```

Use `stageSharedStorage` for Android document or media pickers. Files are
placed under `/sdcard/Download/<namespace>`; `reset: true` removes only that
namespace.

## Locale and device state

- `changeLocalization` sets language, region, time zone, and formatting for a
  device. Set the locale before launching the app.
- `setDeviceState` configures supported system state such as biometric
  enrollment.
- `biometricAuth` simulates a match or failure on supported emulators and iOS
  simulators.
- `wakeAndUnlock` wakes an Android device and unlocks it with an optional PIN.
- `postNotification` creates a notification for notification-flow tests.
- `clipboard` sets, reads, pastes, or clears clipboard content.

For a clean app start, use `launchApp` with `clearAppData: true` where the
platform supports it. Use `observe` after preparation to confirm the expected
state before continuing.

## Device snapshots

Use `deviceSnapshot` to capture a known-good state before a destructive flow,
then restore it for the next run:

```json
{
  "name": "deviceSnapshot",
  "arguments": {
    "action": "capture",
    "snapshotName": "signed-in",
    "platform": "android",
    "includeAppData": true,
    "includeSettings": true
  }
}
```

Android emulators can restore full VM snapshots. iOS simulators back up the
specified app containers; physical Android devices restore settings only.
Restore with `action: "restore"` and the same `snapshotName`.

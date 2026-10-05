# android-launcher fixtures

Captured output, not hand-written. Verbatim copies of manual-test batch 11 captures.

- Captured 2026-10-03 on emulator `emulator-5600`, AVD `am-api36-ga-arm64` (API 36, Android 16,
  `google/sdk_gphone64_arm64/emu64a:16/BE2A.250530.026.F3/13894323:userdebug/dev-keys`), at
  kaeawc/auto-mobile commit `1db0d5733`.
- Command for both files: `adb -s emulator-5600 shell dumpsys package <pkg>` (same output as
  `pm dump <pkg>`).
- `dumpsys-package-playground-launcher.txt`: `dev.jasonpearson.automobile.playground`, installed.
  Its only `android.intent.action.MAIN` activity (`.MainActivity`) carries
  `Category: "android.intent.category.LAUNCHER"`.
- `dumpsys-package-egg-no-launcher.txt`: `com.android.egg`, installed system app. Six activities
  register `android.intent.action.MAIN`, but none has the LAUNCHER category, so the package has no
  launcher activity. Its first MAIN activity is `.landroid.MainActivity` (DEFAULT + PLATLOGO).

## Launcher surface observations

Seven verbatim `observe` captures (including the raw hierarchy), captured 2026-10-05 in
manual-test batch 32 on emulator-5600 (phone) and emulator-5602 (foldable), API 36,
`com.google.android.apps.nexuslauncher`, tested main SHA `0cd001971`. These are copied
observations, not hand-written fixtures.

- `launcher-home-emulator-5600.json` and `launcher-home-emulator-5602.json`: home workspace.
- `launcher-recents-emulator-5600.json` and `launcher-recents-emulator-5602.json`: Recents overview.
- `launcher-allapps-emulator-5600.json` and `launcher-allapps-emulator-5602.json`: all-apps drawer.
- `launcher-widgets-emulator-5600.json`: widgets picker (phone only).

No open-folder capture exists. Both home captures expose a visible `workspace` with
`occlusionState: "partial"`; the five overlay captures omit it. The foldable all-apps
capture retains a visible `hotseat`, so hotseat presence cannot establish home.

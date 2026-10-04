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

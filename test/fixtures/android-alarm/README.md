# Android `dumpsys alarm` fixtures

Captured output of `dumpsys alarm` for `AlarmDumpParser` / `BackgroundWork.listAlarms`
(#14090, #18773), one file per form factor and API level: `dumpsys-alarm-<suffix>.txt`. The
whole-device dump is kept, so each file also holds other packages' alarms; the tests pick a
package that has alarms (`com.google.android.gms`, or `com.google.android.networkstack` on API 30)
and a repeating one (`com.google.android.apps.wallpaper`).

Format points the captures pin that the earlier hand-built files did not:

- An alarm backed by a listener prints `operation=null` and then `listener=...`.
- Android 11 prints `window=0 repeatInterval=0 count=0 flags=0x9` on its own line, and Android 14
  prints the window as a duration (`window=+22m30s0ms`).
- API 30 headers read `Alarm{<hash> type N when <ms> <pkg>}`; API 33 and later read
  `origWhen <ms> whenElapsed <ms>`.

## Provenance

Captured 2026-11-22 from AutoMobile source commit `6989f73a914` by running the commands below with
`adb -s <serial> shell ...` (or `adb -s <serial> emu ...`) on Android emulator 37.2.13.0 (arm64, Apple
silicon host), one fresh AVD per row. Each file is the command's stdout with CRLF normalised to LF; no
other byte was changed. The files do not go through the fixture capture harness
([fixture capture mode](../../../docs/how-it-works/fixture-capture.md)), so they carry no
`.provenance.json` sidecar; this table is the record.

| Suffix             | AVD image                                                | `ro.build.fingerprint`                                                                      |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `phone-api30`      | `android-30;google_apis` (Pixel 5)                       | `google/sdk_gphone_arm64/emulator_arm64:11/RSR1.240422.006/12134477:userdebug/dev-keys`     |
| `phone-api33`      | `android-33;google_apis` (Pixel 6)                       | `google/sdk_gphone64_arm64/emu64a:13/TE1A.240213.009/12342917:userdebug/dev-keys`           |
| `phone-api34`      | `android-34;google_apis` (Pixel 6)                       | `google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.050/12077443:userdebug/dev-keys`           |
| `phone-api35`      | `android-35;google_apis` (Pixel 6)                       | `google/sdk_gphone64_arm64/emu64a:15/AE3A.240806.043/12960925:userdebug/dev-keys`           |
| `phone-api37`      | `android-37.0;google_apis` (Pixel 6)                     | `google/sdk_gphone64_arm64/emu64a:17/CE2A.260420.019/15611780:userdebug/dev-keys`           |
| `watch-api37`      | `android-37.0;android-wear-signed` (Wear OS small round) | `google/sdk_gwear_arm64/emu64a:17/CP2A.260330.028.E2/15706224:user/release-keys`            |
| `tv-api36`         | `android-36;android-tv` (TV 1080p)                       | `google/sdk_google_atv64_arm64/emu64a:16/BT2A.260319.001/15058170:user/dev-keys`            |
| `automotive-api34` | `android-34-ext9;android-automotive` (1024p landscape)   | `google/sdk_gcar_arm64/emulator_car64_arm64:14/UAA1.250512.001/13479943:userdebug/dev-keys` |

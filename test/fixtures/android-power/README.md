# Android power fixtures (`setDeviceState.power`, #14084, #18773)

Captured output of the commands `AdbPowerClient` runs.

| File                                                       | Command                                                               | Format point it pins                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `dumpsys-battery-<suffix>.txt`                             | `dumpsys battery` (untouched emulator)                                | `AC powered: true`, `status: 2`; the TV image reports `present: false`, `status: 1`, `level: 0`; Automotive `present: false` |
| `dumpsys-battery-faked-unplugged-level-15-phone-api34.txt` | `dumpsys battery` after `unplug`, `set level 15`, `set status 3`      | `(UPDATES STOPPED ...)` marks a fake; all chargers false                                                                     |
| `dumpsys-thermalservice-<suffix>.txt`                      | `dumpsys thermalservice`                                              | `IsStatusOverride: false`, `Thermal Status: 0`                                                                               |
| `dumpsys-thermalservice-override-3-phone-api34.txt`        | `dumpsys thermalservice` after `cmd thermalservice override-status 3` | `IsStatusOverride: true`, `Thermal Status: 3`                                                                                |
| `netpolicy-restrict-background-*-phone-api34.txt`          | `cmd netpolicy get restrict-background`                               | `Restrict background status: enabled\|disabled`                                                                              |
| `deviceidle-force-idle-deep-phone-api34.txt`               | `dumpsys deviceidle force-idle deep`                                  | `Now forced in to deep idle mode`                                                                                            |
| `deviceidle-force-idle-not-enabled-automotive-api34.txt`   | `dumpsys deviceidle force-idle deep` on Automotive                    | `Unable to go deep idle; not enabled`                                                                                        |

Single-token outputs (`dumpsys deviceidle get deep`, `enabled deep`, `settings get global low_power`,
`am get-standby-bucket`, `am get-inactive`) are asserted inline in the tests and were not
re-captured. Battery state was reset (`dumpsys battery reset`), thermal override reset and
restrict-background returned to `false` after each capture.

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

# Android emulator `sensor` console fixtures

Captured output of `adb -s <serial> emu sensor ...` on the `phone-api34` AVD for
`EmulatorSensors` (#14114, #18773). The console prints `<name> = a[:b[:c]]` and then `OK`; the
emulator console's CRLF line endings are normalised to LF.

| File                                            | Command                                     | Format point it pins                                                         |
| ----------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| `sensor-get-acceleration-phone-api34.txt`       | `emu sensor get acceleration`               | Three values; after an earlier `set acceleration 1` the x component read `1` |
| `sensor-get-magnetic-field-phone-api34.txt`     | `emu sensor get magnetic-field`             | Hyphenated name; negative component                                          |
| `sensor-get-orientation-phone-api34.txt`        | `emu sensor get orientation`                | Three values in degrees                                                      |
| `sensor-get-light-phone-api34.txt`              | `emu sensor get light`                      | One value                                                                    |
| `sensor-get-proximity-phone-api34.txt`          | `emu sensor get proximity`                  | One value                                                                    |
| `sensor-get-pressure-phone-api34.txt`           | `emu sensor get pressure`                   | One fractional value                                                         |
| `sensor-get-humidity-phone-api34.txt`           | `emu sensor get humidity`                   | The phone AVD enables humidity (`humidity = 0`)                              |
| `sensor-set-ok-phone-api34.txt`                 | `emu sensor set light 500`                  | A bare `OK`                                                                  |
| `sensor-set-usage-ko-phone-api34.txt`           | `emu sensor set acceleration`               | `KO: Usage:` refusal for a missing value list                                |
| `sensor-get-acceleration-disabled-tv-api36.txt` | `emu sensor get acceleration` on the TV AVD | `KO: 'acceleration' sensor is disabled.`; no `OK` trailer                    |

The TV and Automotive AVDs disable the motion sensors; a phone AVD does not disable humidity, so
the earlier `humidity` refusal case is now the TV acceleration capture. Only `emu sensor` replies
come from the AVD named in the provenance table; the `-api34` suffix here names the phone AVD.

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

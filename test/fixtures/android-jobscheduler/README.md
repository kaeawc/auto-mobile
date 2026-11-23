# Android `dumpsys jobscheduler` fixtures

Captured output of `dumpsys jobscheduler <package>` for `JobSchedulerDumpParser` (#14090, #18773).

- `dumpsys-jobscheduler-android-<suffix>.txt`: `dumpsys jobscheduler android` (the system's own
  jobs, present on every image) on each form factor and API level.
- `dumpsys-jobscheduler-wellbeing-phone-api34.txt`: `dumpsys jobscheduler
  com.google.android.apps.wellbeing`, six WorkManager jobs (`SystemJobService`).
- `dumpsys-jobscheduler-invalid-package-phone-api34.txt`: `dumpsys jobscheduler dev.example.none`,
  which prints `Invalid package: dev.example.none`.

API 30 ignores the package argument and prints every package's jobs (hence its file is large), so
the parser filters by service package. API 33 and later filter in the service and print `None.`
under `Registered N jobs:` for a package without jobs.

The running and pending queue sections stay empty on these idle emulators, so the `pending` and
`running` flags have no captured case; `WorkManagerDiagnosticsParser` input is a logcat excerpt that
the tests still build inline.

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

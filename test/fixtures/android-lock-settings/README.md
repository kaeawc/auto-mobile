# Android `locksettings` / `dumpsys lock_settings` fixtures

Captured output for `AndroidLockSettings` and the screen-lock session cleanup (#14107, #18773).
The PIN used was `1357`; `locksettings` output is the shell command's stdout only, and the
AutoMobile exit-status marker that `AdbLockSettingsClient` appends is added by the tests.

| File                                                      | Command                                            | Format point it pins                                                            |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `dumpsys-lock-settings-none-<suffix>.txt`                 | `dumpsys lock_settings` (no lock)                  | `CredentialType: None` (API 30, 33) or `NONE` (API 34 and later) under `User 0` |
| `dumpsys-lock-settings-pin-<suffix>.txt`                  | `dumpsys lock_settings` after `set-pin`            | `Pin` / `PIN`; the TV image has no lock screen and stays `NONE`                 |
| `dumpsys-lock-settings-pin-automotive-api34.txt`          | the same on Automotive, whose current user is 10   | `User 0` stays `NONE` while `User 10` holds the PIN                             |
| `locksettings-set-pin-ok-phone-api34.txt`                 | `locksettings set-pin 1357`                        | Success echoes the new credential (`Pin set to '...'`)                          |
| `locksettings-clear-ok-phone-api34.txt`                   | `locksettings clear --old 1357`                    | `Lock credential cleared`                                                       |
| `locksettings-old-mismatch-phone-api34.txt`               | `locksettings set-pin --old 2468 1357` (a PIN set) | Refusal echoes the old credential                                               |
| `locksettings-old-without-credential-phone-api34.txt`     | `locksettings clear --old 1357` (no lock)          | `Old password provided but user has no password`                                |
| `locksettings-set-pin-no-secure-lock-screen-tv-api36.txt` | `locksettings set-pin 1357` on the TV image        | `The device does not support lock screen - ignoring the command.`               |

The Android 10 integer `CredentialType` and a dump with no type line are not reproducible on the
available images, so the tests build those two one-line cases inline. Both success and refusal
messages echo a credential, which is why the client scrubs all `locksettings` output.
`locksettings` acts on the current user while the reader checks user 0; the Automotive capture is
why the client now passes `--user 0`.

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

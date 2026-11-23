# Android notification enabled fixtures

`set-enabled-api37-stdout.txt` and `set-enabled-api37-exit-code.txt` preserve
only the real failure capture supplied with this task: a real adb run on
2026-10-25, API 37, of
`adb shell cmd notification set_enabled 'dev.jasonpearson.automobile.playground' true`.
Stdout was `Unknown command: set_enabled`; exit code was 255.

`get-post-notification-<mode>-<suffix>.txt` are captured `adb shell cmd appops get
dev.jasonpearson.automobile.playground POST_NOTIFICATION` output after `cmd appops set <pkg>
POST_NOTIFICATION <mode>` for `allow`, `deny`, `ignore`, `foreground` and `default` (#18773). The
package is the repository's Playground debug APK (minSdk 24).

| Suffix             | AVD image                                              | Output shape                                                                           |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `phone-api30`      | `android-30;google_apis` (Pixel 5)                     | `POST_NOTIFICATION: <mode>`; the pre-33 path `SetAndroidNotificationsEnabled` verifies |
| `phone-api33`      | `android-33;google_apis` (Pixel 6)                     | the same one-line shape                                                                |
| `phone-api34`      | `android-34;google_apis` (Pixel 6)                     | the same one-line shape                                                                |
| `phone-api35`      | `android-35;google_apis` (Pixel 6)                     | `No operations.` and `Default mode: allow` after every set: no op is recorded          |
| `automotive-api34` | `android-34-ext9;android-automotive` (1024p landscape) | the same one-line shape                                                                |

Captured 2026-11-22 from AutoMobile source commit `6989f73a914` on Android emulator 37.2.13.0
(arm64), one fresh AVD per row; `ro.build.fingerprint` values are listed in
`../android-power/README.md`. The files are stdout, byte for byte. They do not go through the
fixture capture harness, so this table is the provenance record. The API 37 phone, Wear OS and Android TV AVDs
(API 37, 37 and 36) print a second line, `Uid mode: POST_NOTIFICATION: ignore`, before
`POST_NOTIFICATION: allow` whatever mode was set; those two shapes are not fixtures because the
parser only reads the package line and the API 33+ path does not use `appops get`.

`api35-deskclock-{granted,revoked}-dumpsys-package.txt` are verbatim runtime-permission
section captures for `com.google.android.deskclock` (UID 10151) on Android 15,
API 35. Revoking POST_NOTIFICATIONS disabled notifications; granting it restored
them. Tests supply synthetic package/user headers around these captured sections
so the package permission parser can read them. The appops and notification-settings
captures are omitted because these tests do not consume them.

The `cmd appops get` read-back before API 33 is captured on API 30.
Other permission read-back tests reuse the existing captured
`android-dumpsys-package/dumpsys-package-system-installed.txt`; renamed packages,
user IDs, and denied grant variants are hand-reconstructed test adaptations.

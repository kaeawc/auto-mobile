# Android `dumpsys package` captures

- **Source:** manual-test batch 11; provenance from `/tmp/mtb11/captures/README.md`, section `dumpsys package`.
- **Device:** emulator `emulator-5600`, AVD `am-api36-ga-arm64`, `sdk_gphone64_arm64`, Pixel 7 profile (1080x2400).
- **API level:** 36 (Android 16).
- **Build:** `google/sdk_gphone64_arm64/emu64a:16/BE2A.250530.026.F3/13894323:userdebug/dev-keys`.
- **Date:** 2026-10-03.
- **Commit:** `1db0d5733` (`kaeawc/auto-mobile` main).
- **Exact capture command:** `adb -s emulator-5600 shell dumpsys package <pkg>`.

These files are whole, raw, unedited command output, copied verbatim from the captures. They must not be trimmed or reformatted.

| File                                             | Package                                  | App state                                                                                      | How the state was produced                                                        |
| ------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `dumpsys-package-installed.txt`                  | `dev.jasonpearson.automobile.playground` | Installed user app; `installed=true hidden=false suspended=false enabled=0`                    | `adb install -r app-debug.apk`                                                    |
| `dumpsys-package-not-installed.txt`              | `com.example.not.installed`              | Not installed; single line `Unable to find package: com.example.not.installed`                 | No state-changing command recorded                                                |
| `dumpsys-package-suspended.txt`                  | `dev.jasonpearson.automobile.playground` | `suspended=true`                                                                               | `pm suspend <pkg>`                                                                |
| `dumpsys-package-hidden.txt`                     | `dev.jasonpearson.automobile.playground` | `hidden=true`                                                                                  | `su 0 pm hide <pkg>` (plain shell `pm hide` was refused with a SecurityException) |
| `dumpsys-package-disabled-user.txt`              | `dev.jasonpearson.automobile.playground` | `enabled=3` (disabled-user)                                                                    | `pm disable-user --user 0 <pkg>`                                                  |
| `dumpsys-package-uninstalled-user0-keepdata.txt` | `dev.jasonpearson.automobile.playground` | `installed=false`, data kept; absent from `pm list packages`, present in `pm list packages -u` | `pm uninstall -k --user 0 <pkg>`                                                  |
| `dumpsys-package-system-installed.txt`           | `com.android.egg`                        | Installed system app; baseline for the next row                                                | No state-changing command recorded                                                |
| `dumpsys-package-system-uninstalled-user0.txt`   | `com.android.egg`                        | System app; `installed=false` for user 0, `ceDataInode=-1 deDataInode=-1`                      | `pm uninstall --user 0 com.android.egg`                                           |

## `dumpsys-package-messaging-permissions-section.txt`

- **Package:** `com.google.android.apps.messaging`, which declares restricted permissions (`READ_SMS`, `READ_CALL_LOG`, `RECEIVE_SMS`, `READ_EXTERNAL_STORAGE`, ...).
- **Device:** emulator `emulator-5600` (manual-test batch mt40, 2026-10-06). Its API level and build were not recorded with the capture; `emulator-5602` produced a byte-identical section.
- **Capture:** the `declared permissions:` through `runtime permissions:` lines of `adb -s emulator-5600 shell dumpsys package com.google.android.apps.messaging`, copied verbatim. It has no `Package [...]` header or `User 0:` line (the full dump is about 215 KB, mostly the activity resolver table), so the test prepends one header line before parsing and reads only the requested section.
- **Why it exists:** it pins that restricted permissions appear in `requested permissions:` as bare names (no `: restricted=true` suffix); the restriction shows only in the runtime `flags=[ ... RESTRICTION_SYSTEM_EXEMPT|RESTRICTION_UPGRADE_EXEMPT]` list (issue #10189).

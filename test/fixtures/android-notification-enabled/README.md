# Android notification enabled fixtures

`set-enabled-api37-stdout.txt` and `set-enabled-api37-exit-code.txt` preserve
only the real failure capture supplied with this task: a real adb run on
2026-10-25, API 37, of
`adb shell cmd notification set_enabled 'dev.jasonpearson.automobile.playground' true`.
Stdout was `Unknown command: set_enabled`; exit code was 255.

> [!NOTE]
> The `get-post-notification-api{33,37}-*.txt` fixtures are **hand-reconstructed**
> from the AOSP AppOpsService shell output shape, not captured from a device in
> this change. Replace them with real captures
> (`adb shell cmd appops get <pkg> POST_NOTIFICATION > file.txt`) when a device
> run disagrees with them. They provide no device verification of the fix.

Both API sets cover allow, deny, ignore, default (`No operations.`), and
foreground. API 33 files use bare mode lines; API 37 files include access or
rejection history suffixes. These API labels describe representative output
shapes, not verified platform differences.

`api35-deskclock-{granted,revoked}-dumpsys-package.txt` are verbatim runtime-permission
section captures for `com.google.android.deskclock` (UID 10151) on Android 15,
API 35. Revoking POST_NOTIFICATIONS disabled notifications; granting it restored
them. Tests supply synthetic package/user headers around these captured sections
so the package permission parser can read them. The appops and notification-settings
captures are omitted because these tests do not consume them.

The `cmd appops set/get` path before API 33 is **NOT device-verified**.
Other permission read-back tests reuse the existing captured
`android-dumpsys-package/dumpsys-package-system-installed.txt`; renamed packages,
user IDs, and denied grant variants are hand-reconstructed test adaptations.

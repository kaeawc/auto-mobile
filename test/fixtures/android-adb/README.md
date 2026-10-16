# android-adb fixtures

Captured output, not hand-written. Saved unmodified from an `android-36 google_apis arm64`
emulator (`emulator-5556`, single primary user, no work profile), 2026-10-15.

- `adb-version.txt`: `adb version` output.
- `adb-devices-l.txt`: `adb devices -l` (host-wide; also lists the unrelated `emulator-5554`).
- `dumpsys-user.txt`: `adb -s emulator-5556 shell dumpsys user`.
- `pm-list-users.txt`: `adb -s emulator-5556 shell pm list users`.

`*.txt` here is pinned `text eol=lf` in `.gitattributes`. Multi-user and offline-device shapes
are not captured yet; their tests stay hand-typed and are labelled supplementary.

# Android volume command output

Captured read-only on 2026-10-28 (America/Chicago). Device class: Wear OS ARM64
emulator, Android 17, API 37, product `sdk_gwear_arm64`. Build fingerprint:

`google/sdk_gwear_arm64/emu64a:17/CP2A.260330.028.E2/15706224:user/release-keys`.

Files preserve raw stdout and stderr separately; every capture exited 0 and every
stderr file is empty. No mutating command was executed. Stream levels are snapshots
of other lanes' devices, not the result of a mutation in this lane.

| File prefix              | Exact capture command                                                   |
| ------------------------ | ----------------------------------------------------------------------- |
| `api37-sdk`              | `adb -s emulator-5620 shell getprop ro.build.version.sdk`               |
| `api37-release`          | `adb -s emulator-5620 shell getprop ro.build.version.release`           |
| `api37-product`          | `adb -s emulator-5620 shell getprop ro.product.name`                    |
| `api37-fingerprint`      | `adb -s emulator-5620 shell getprop ro.build.fingerprint`               |
| `api37-stream-6`         | `adb -s emulator-5620 shell cmd media_session volume --stream 6 --get`  |
| `api37-stream-5`         | `adb -s emulator-5620 shell cmd media_session volume --stream 5 --get`  |
| `api37-stream-1`         | `adb -s emulator-5620 shell cmd media_session volume --stream 1 --get`  |
| `api37-stream-11`        | `adb -s emulator-5620 shell cmd media_session volume --stream 11 --get` |
| `api37-stream-9`         | `adb -s emulator-5620 shell cmd media_session volume --stream 9 --get`  |
| `api37-stream-10`        | `adb -s emulator-5620 shell cmd media_session volume --stream 10 --get` |
| `api37-stream-0`         | `adb -s emulator-5620 shell cmd media_session volume --stream 0 --get`  |
| `api37-stream-2`         | `adb -s emulator-5620 shell cmd media_session volume --stream 2 --get`  |
| `api37-stream-4`         | `adb -s emulator-5620 shell cmd media_session volume --stream 4 --get`  |
| `api37-stream-3`         | `adb -s emulator-5620 shell cmd media_session volume --stream 3 --get`  |
| `api37-5622-music`       | `adb -s emulator-5622 shell cmd media_session volume --stream 3 --get`  |
| `api37-5622-fingerprint` | `adb -s emulator-5622 shell getprop ro.build.fingerprint`               |

Each prefix has `.stdout.txt` and `.stderr.txt` files.

`api37-audio-set-volume-3-5.issue.txt` is **transcribed from issue #15804 comment output**:
`calling AudioManager.setStreamVolume(3, 5, 0)` for the reported command
`adb shell cmd audio set-volume 3 5` on the API 37 `sdk_gwear_arm64` emulator.
Original capture date, serial, complete stdout/stderr and exit status were not supplied.
The final newline is a text-file delimiter, not verified capture metadata.

## GAPS

- The setter success line is an issue transcription, not a new live capture; no writes
  were permitted. Actual set/revert behavior, aliases, and accessibility writability
  were not exercised on a device.
- No captured source exists for pre-34 `cmd media_session volume --set` output or
  for `cmd audio` on older APIs. Unsupported-command/usage and permission/transport
  failure responses in shell fakes are synthetic control signals, not captured fixtures.
- Existing media-controller tests retain their pre-existing synthetic volume readings;
  new parser and shell tests consume the captures here.

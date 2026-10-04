# Android getevent captures

`same-coordinate-taps-api36.txt` is captured output, not hand-written. Source:
issue #9143, filed 2026-10-03.

- Device: `am-api36-ga-arm64` emulator, API 36.
- Input node: `/dev/input/event1` (`virtio_input_multi_touch_1`).
- Main commit: `69ab972ef`.
- Taps were written with `sendevent` while `startTestRecording` was running and
  observed with `adb shell getevent -lt /dev/input/event1`.
- Raw coordinates: (27852, 16165) = (0x6ccc, 0x3f25).
- The second contact deliberately has no ABS_MT_POSITION lines: Protocol B
  retains the slot's coordinates when they do not change.

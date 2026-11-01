# Android uinput pen captures

Captured 2026-11-01 on emulator-5610, AVD `n4-13084b-userdebug-api37`
(a copy of `n4-13084-userdebug-api37`):
Android 17, API 37, `google_apis` arm64, `ro.build.type=userdebug`.
Strokes ran through the private-daemon uinput route, using the `automobile-pen`
virtual device and `/system/bin/uinput`.

Each `-getevent-lt` file is `adb shell timeout 12 getevent -lt` taken while the
stroke ran. Each `-lp-during` file is `adb shell timeout 2 getevent -lp` taken
2 s into the stroke.

Stroke inputs:

- Stylus taps at (540,1170), pressure 0.5 and 0.2.
- Eraser tap at (540,1170), pressure 0.5.
- Stylus swipe from (300,1400) to (300,900) over 800 ms, pressure 0.6.
- Stylus hover over (300,900), (350,850), (400,800).

Additional stylus captures use the same device on 2026-11-01, with display geometry
1080x2340, rotation 0. The tap point is (540,1170), pressure 0.5:

- `tap-stylus-tilt-45deg-orientation-30deg`: tilt 0.7853981633974483,
  orientation 0.5235987755982988 radians.
- `tap-stylus-tilt-30deg-orientation-minus90deg`: tilt 0.5235987755982988,
  orientation -1.5707963267948966 radians.
- `tap-stylus-tilt-45deg-orientation-0-barrel-both`: tilt 0.7853981633974483,
  orientation 0, buttons `["primary", "secondary"]`.
- `tap-stylus-barrel-primary`: buttons `["primary"]`, no tilt or orientation.
- `tap-stylus-barrel-secondary`: buttons `["secondary"]`, no tilt or orientation.
- `swipe-stylus-tilt-45deg-orientation-30deg-barrel-primary`: the same swipe
  coordinates, duration and pressure 0.6 as above, tilt 0.7853981633974483,
  orientation 0.5235987755982988 radians, buttons `["primary"]`.

The `-lp-during` snapshots for `tap-stylus-tilt-45deg-orientation-0-barrel-both`
and `tap-stylus-barrel-secondary` missed the short-lived pen; their `-lt` streams
contain the stroke. The other four new capability snapshots include the pen.

`stylus-tilt-swipe-dumpsys-input-device-emulator-5610.txt` is the verbatim
`dumpsys input` block for `automobile-pen` during the tilted swipe. Android derives
its tilt and orientation motion ranges from the degree-valued `ABS_TILT_X/Y` axes.

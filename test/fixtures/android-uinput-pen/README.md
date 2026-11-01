# Android uinput pen captures

Captured 2026-11-01 on emulator-5610, AVD `n4-13084-userdebug-api37`:
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

Tilt, orientation and barrel buttons were not captured; the uinput route refuses them.

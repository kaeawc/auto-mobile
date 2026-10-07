# Android `dumpsys window policy` captures

Every `.txt` file is raw `adb shell dumpsys window policy` output, copied verbatim
(no header lines). Taken 2026-10-06 on API 36 emulators, for issue #10182.

- `dumpsys-window-policy-unlocked-emulator-{5600,5602}.txt`: awake, no keyguard.
- `dumpsys-window-policy-asleep-nokeyguard-emulator-{5600,5602}.txt`: screen off
  (`SCREEN_STATE_OFF`, `INTERACTIVE_STATE_SLEEP`), keyguard enabled but not showing.
- `dumpsys-window-policy-after-wake-nokeyguard-emulator-{5600,5602}.txt`: the same
  devices after `KEYCODE_WAKEUP`; still no keyguard.
- `dumpsys-window-policy-swipe-keyguard-showing-emulator-5602.txt`: a swipe
  keyguard showing after a fold (`showing=true`, `secure=false`, `occluded=false`).
  On that device `locksettings get-disabled` was `true`.

The `KeyguardServiceDelegate` block carries `showing=`, `occluded=` and `secure=`
once each; the dump's other keyguard fields are CamelCase (`mKeyguardOccluded=`,
`mIsShowing=`, `mSimSecure=`). No capture has `occluded=true`.

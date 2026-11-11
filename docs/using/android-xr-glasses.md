# Android XR glasses input

Enable the opt-in `glassesInput` tool to move and click app focus on Android XR glasses.

Call `glassesInput({ gesture: "swipeForward" })` to move down, `swipeBack` to move up, or `tap` to click the focused item. Set `axis: "horizontal"` for right/left movement; the default is `vertical`, and tap ignores the axis. `count` repeats any gesture, including tap, from 1 to 20 times (default 1).

The result contains `success`, `message`, `gesture`, `axis`, `count`, `keyCodes` and `commands`. Success means the adb commands exited cleanly; no read-back is performed. Call `observe` afterwards to verify focus or the click. Commands and key codes list attempted repetitions, including a failed command; remaining repetitions stop on failure.

A `not_glasses` or `traits_unavailable` warning means glasses identity is unconfirmed; input is still sent. Check `listDevices` and observe the effect. Command error output returns `success: false`; transport failures raise an actionable error. Check the Android connection before retrying, since earlier repetitions may already have taken effect. iOS is unsupported.

For voice input, use `injectAudioInput`. Long press and two-finger gestures are not supported.

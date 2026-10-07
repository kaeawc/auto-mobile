# android-focus-multidisplay fixtures (#9208)

Captured, not hand-written. Used by
`test/features/action/SendKeys.capturedMultiDisplayFocus.test.ts`.

- Device: `emulator-5602`, Pixel Fold-profile AVD (API 36, CtrlProxy bound), captured 2026-10-07.
- App/screen: Settings search (`am start -a android.settings.APP_SEARCH_SETTINGS`), whose
  `EditText` ("Search settings") is `focused` and holds window focus.
- `fold-open-*`: posture OPENED (state 2). Logical display 0 is the inner panel
  (`local:4619827259835644672`, 2076x2152); the cover panel is not connected.
- `fold-closed-*`: after `adb emu fold` (state 0 CLOSED), wake + `wm dismiss-keyguard`, same
  search screen. Logical display 0 is now the cover panel (`local:4619827551948147201`,
  1080x2364); the inner panel is not connected.

| File                       | Command                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `*-get-displays.txt`       | `adb shell cmd display get-displays` (verbatim)                                    |
| `*-device-state.txt`       | `adb shell cmd device_state state` (verbatim)                                      |
| `*-window-focus.txt`       | `adb shell dumpsys window \| grep -E "mCurrentFocus\|mFocusedApp\|mFocusedWindow"` |
| `*-ctrlproxy-windows.json` | CtrlProxy websocket `request_hierarchy` reply (`hierarchy_update`), see below      |

`*-ctrlproxy-windows.json` is the wire message with the (large) top-level `data.hierarchy` and
each `data.windows[n].hierarchy` removed; every remaining field is verbatim. The reply was read
over a private `adb forward` to the device's CtrlProxy port, not through any daemon.

Properties the fixtures preserve:

- `windows[]` carries `displayId` and `isFocused` but no `panelUniqueId`, so the focused panel
  is only identifiable through `displayId` plus `cmd display get-displays`.
- Logical display 0 is rebound to whichever panel is connected, so `displayId` alone is the
  same (0) in both postures.
- The fold emulator connects one panel at a time, so the "pinned panel is connected but does
  not hold focus" branch cannot be captured here; it needs two concurrently connected
  displays (the `am-dualdisplay-ext` AVD or real hardware).

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
- The fold emulator connects one panel at a time, so the `fold-open-*`/`fold-closed-*` pair
  cannot show a connected panel that does not hold focus; the `fold-overlay-focus-*` captures
  below add a second, concurrently connected display for that.

## Concurrent displays: `fold-overlay-focus-*`

- Device: `emulator-5660`, Pixel 10 Pro Fold AVD `dv-fold10` (API 36, posture OPENED, CtrlProxy
  bound), captured 2026-10-08. The emulator console's `multidisplay add` is not supported on the
  fold profile, so the second display is a framework overlay display:
  `adb shell settings put global overlay_display_devices 1080x1920/320`. It is logical display 7
  (`overlay:1`, 1080x1920, type OVERLAY) next to the inner panel on logical display 0.
- `fold-overlay-focus-inner-*`: Settings on display 7, then Settings search
  (`am start --display 0 -a android.settings.APP_SEARCH_SETTINGS`) on display 0, which holds
  focus (`mTopFocusedDisplayId=0`).
- `fold-overlay-focus-overlay-*`: Settings on display 0, then Settings search on display 7
  (`am start --display 7 ...`), which holds focus (`mTopFocusedDisplayId=7`).

| File                                | Command                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `*-get-displays.txt`                | `adb shell cmd display get-displays` (verbatim)                                                          |
| `*-device-state.txt`                | `adb shell cmd device_state state` (verbatim)                                                            |
| `*-window-focus.txt`                | `adb shell dumpsys window \| grep -E "mCurrentFocus\|mFocusedApp\|mFocusedWindow\|mTopFocusedDisplayId"` |
| `*-display0-ctrlproxy-windows.json` | CtrlProxy `request_hierarchy` with `displayId: 0`, reduced as above                                      |
| `*-display7-ctrlproxy-windows.json` | CtrlProxy `request_hierarchy` with `displayId: 7`, reduced as above                                      |

What these captures show:

- CtrlProxy answers a display-scoped request with only that display's windows. The pinned
  display's list therefore either contains the focused window (`isFocused: true`, its own
  `displayId`) or has no focused window at all; it never names the other display's focused
  window. A pin on the connected but unfocused display is refused with "focused panel is
  unknown".
- The overlay display is not a physical panel, so the daemon's panel inventory does not list
  it; the test builds a two-panel inventory from `get-displays` (`overlay:1` keys as `1`).

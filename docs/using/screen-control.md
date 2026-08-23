# Controlling a Device from the Desktop App

The AutoMobile desktop app can mirror a connected device's screen **and drive it**. In _control
mode_ the mirrored screen becomes interactive: clicking taps the device, dragging swipes it, and —
on Android — typing forwards to the focused field. This turns the Layout inspector from a
read-only view into a hands-on remote for the device under test.

This page is for people **using the desktop app**. If you are building your own client against the
AutoMobile daemon, see the
[third-party client guide](../design-docs/mcp/daemon/client-screen-control.md) instead.

## Entering and exiting control mode

1. Connect a device or simulator and make sure AutoMobile is observing it (the device is selected
   in the left sidebar and its screen is streaming in the Layout inspector).
2. Open the **Layout** inspector panel and turn on its **Live** toggle. The mirror starts showing
   the live screen.
3. When a live, paired frame is available for the selected real device, the mirror becomes
   **interactive automatically** — that is control mode. Until then it stays a read-only inspector.

To **exit**, turn the **Live** toggle off or close the Layout panel. (Pressing **Escape** does not
exit control mode: while the mirror is focused, Escape is forwarded to the device as the Back
button; while it is unfocused, Escape only deselects/closes the inspector pane.) Leaving control
mode returns the view to the ordinary inspector (click-to-select, hover-to-highlight).

Control mode is **opt-in**. Among AutoMobile's own surfaces only the desktop app enables it — the
IDE plugin stays inspector-only — though any third-party client built on the daemon can offer the
same control surface (see the
[third-party client guide](../design-docs/mcp/daemon/client-screen-control.md)). It never turns on
for mock/demo data, for a device that is not explicitly selected, or when the stream is
disconnected — in every one of those cases the mirror falls back to the plain inspector.

## Supported interactions

| You do                                            | The device gets                                      |
| ------------------------------------------------- | ---------------------------------------------------- |
| **Click** the mirror                              | A tap at that point                                  |
| **Drag** across the mirror                        | A swipe from where you pressed to where you released |
| **`Esc`** (mirror focused)                        | The Back button                                      |
| **Enter / Tab / Backspace / Delete / arrow keys** | The matching key press (Android)                     |
| **Type ASCII text**                               | The text, appended to the focused field (Android)    |

A few details worth knowing:

- **Panning while in control mode.** A plain drag is a _swipe_, so to pan/scroll the mirror view
  itself hold the zoom modifier (**Cmd** on macOS, **Ctrl** elsewhere) while dragging. Zoom with
  the same modifier + scroll wheel, or the on-screen zoom buttons.
- **Tiny drags do nothing.** A drag shorter than a small threshold is neither a swipe nor a tap —
  this stops pointer jitter from actuating the device.
- **Keyboard needs focus.** Click the mirror first so it holds keyboard focus; only then do
  keystrokes forward. Clicking the mirror always re-focuses it.
- **App/window shortcuts still work.** A shortcut with Ctrl, Alt, or Cmd/Win generally stays with
  the desktop app and is not sent to the device, so your menus and window shortcuts are unaffected.
  The one exception is character composition — AltGr on Windows/Linux, Option on macOS — but only
  when it produces a **printable ASCII** character (`U+0020`–`U+007E`): that types on the device. A
  composed non-ASCII character (`€`, `ß`, an accented letter) is **not** forwarded and stays with
  the desktop app, the same ASCII-only limit that applies to typing in general (see
  [#4519](https://github.com/kaeawc/auto-mobile/issues/4519)). See the
  [keyboard forwarding policy](../design-docs/mcp/daemon/screen-control-mapping.md#keyboard-forwarding-policy)
  for the exact rule.

## Feedback

- **Success** — a brief blue pulse appears where you tapped, confirming the input was forwarded.
  Shortly after, the mirror refreshes to show the device's new state.
- **Failure** — if an input fails (for example a key the device cannot accept), a dismissible error
  banner explains what happened.
- **Unavailable** — if control cannot be offered (device disconnected, frame stale), the mirror
  quietly falls back to the read-only inspector, and a small notice may explain why.

## Android vs iOS

| Interaction                        | Android                    | iOS (simulator)                    |
| ---------------------------------- | -------------------------- | ---------------------------------- |
| Tap                                | ✅                         | ✅                                 |
| Drag → swipe                       | ✅                         | ✅                                 |
| Back button (`Esc`)                | ✅                         | ✅                                 |
| Discrete keys (Enter, Tab, arrows) | ✅                         | ❌ not available                   |
| Typing text                        | ✅ (appended to the field) | ✅ (appended at the focused caret) |

**How typing works on iOS.** Control mode forwards printable ASCII text in append mode. CtrlProxy
inserts it at the focused field's current caret through XCUITest `typeText`, without clearing the
field or resolving a resource ID. Older runners use their existing focused-field text command as a
compatibility path. Tapping, swiping, and the Back button continue to work on iOS; discrete keys
such as Enter, Tab, and arrows remain unavailable.

## The IDE plugin is inspector-only

The IntelliJ / Android Studio plugin shares the same layout-inspector view but **does not offer
control mode**. It selects and highlights elements only, and never sends input to the device. This
is intentional — screen control is a desktop-app (and third-party client) feature, not an IDE
plugin feature.

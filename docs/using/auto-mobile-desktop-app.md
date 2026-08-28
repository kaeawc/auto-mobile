# AutoMobile Desktop App

The desktop app's Layout inspector mirrors a connected device and sends input
to it automatically.

## Supported interactions

| Desktop action | Device action |
| --- | --- |
| Click the mirror | Tap |
| Drag across the mirror | Swipe |
| `Esc` while the mirror is focused | Back |
| Enter, Tab, Backspace, Delete, or arrows | Matching Android key press |
| Type ASCII text | Text in the focused field |

A plain drag moves the device. Hold **Cmd** on macOS or **Ctrl** elsewhere while
dragging to pan the mirror; use the same modifier with the scroll wheel to zoom.
Click the mirror before typing so it has keyboard focus. Desktop shortcuts stay
with the desktop app.

Typing on iOS inserts printable ASCII at the focused caret. Discrete keys such
as Enter, Tab, and arrows are not available on iOS. iOS control requires a
simulator and a connected CtrlProxy runner.

If an input fails, read the error banner. If the device disconnects or the frame
becomes stale, reconnect it; control resumes automatically when the stream is
available.


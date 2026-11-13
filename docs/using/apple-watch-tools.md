# Apple Watch tool behavior

This page describes how each tool that accepts an [Apple Watch simulator](apple-watch.md) behaves
on a watch. Every call names the watch with `platform: "watchos"`.

## observe

`observe` returns a screenshot. With the automation runner connected, it also returns the target
app's view hierarchy and on-screen system alerts, even when the app is not in the foreground. Those
alerts include the notification permission prompt and the notification short look and long look
with action buttons.

- If AutoMobile cannot read the hierarchy, the result carries `hierarchyUnavailable` and no
  hierarchy fields.
- When the target app is not in the foreground, the message says to call `launchApp` to bring it
  back, or to post a notification and retry `observe`. Read the screenshot meanwhile.
- When the app `launchApp` started has exited or crashed, `hierarchyUnavailable` carries
  `appNotRunning: { bundleId }`. Read `getLogs` for the crash and call `launchApp` to start it again.
- With a hierarchy, bounds and `screenSize` are in points and `screenshotImageSize` is in pixels. A
  screenshot-only result reports `screenSize` in pixels. Check `screenSize.units` (`points` or
  `physical-pixels`) before using it for `tapAt`, which takes points.
- With the runner connected, an element `waitFor` re-reads the hierarchy until it matches or
  `timeout` elapses.

The watch refuses these options: `waitFor` with `for`, `posture`, `activeDisplay` or
`activeWindow`; `waitFor` without a runner; `settled`, `raw`, `includeExtras`, `scope`, `layer`,
`skipBackStack`, `crop`, `screenshotOptions` and `screenshot: "none"`.

## tapOn and tapAt

`tapOn` takes a `selector` with an exact `elementId` or `text`, and an optional `index`. It supports
only `action: "tap"`. Only elements wholly on screen match, including notification action buttons.
The notification permission prompt scrolls: use `rotateCrown` to bring `Allow` wholly into view
before you select it.

`tapAt` takes absolute coordinates in points. A point outside the watch screen fails with
`tap is outside the watch screen`. Take the coordinates from `observe`, within `screenSize`.

With the host app not in the foreground and no Smart Stack open, `tapAt` taps the watch face at the
given point. A device has not confirmed whether such a tap opens a complication, so `observe`
afterwards. In that state `tapOn` still needs the host app in the foreground.

### Smart Stack widgets

When the Smart Stack is open and the host app is not in the foreground:

- `tapOn` matches a widget's exact text or cell identifier on the watch face. Only cards wholly on
  screen match. AutoMobile refuses text that only an off-screen widget shows, with a hint to scroll
  the Smart Stack first.
- `tapAt` taps widgets by point coordinates too.
- `observe` returns `hierarchyUnavailable` and no hierarchy fields.

Tapping a widget opens its host app, so the normal tools work afterwards. A widget you just added
shows its text about 2 seconds after the final Done tap. Wait about 2 seconds once before you match
it. See [Smart Stack](../how-it-works/plat/watchos/smart-stack.md) for how this works.

## swipeOn and pressButton

`swipeOn` swipes in a direction, including on the watch face after `pressButton` with `home`. With
`lookFor`, it swipes until an exact `text` or `elementId` is on screen, up to `maxSwipes` (default
10, maximum 100). Each `lookFor` step is a short, slow drag of about one row, so consecutive reads
overlap and do not skip nearby targets. You cannot set coordinates or duration.

`pressButton` supports `home` only.

## rotateCrown

`rotateCrown` turns the Digital Crown. Enable it with `setToolEnabled` (see
[Dynamic Tools](dynamic-tools.md)).

```json
{ "name": "rotateCrown", "arguments": { "platform": "watchos", "delta": 2 } }
```

| Parameter  | Meaning                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `delta`    | Signed, non-zero, in full crown revolutions: `1` is one complete turn, `0.25` a quarter turn. The sign sets the direction |
| `velocity` | Optional, positive. Default 1                                                                                             |

The app's crown binding (step size and sensitivity) decides how far a turn moves a control. One
revolution can cross a whole small control. On a 0–10 control with step 1 and medium sensitivity,
`0.25` moves about 3 steps, `0.5` about 7, and `1` reaches the end. To reach an intermediate value,
use fractional deltas and `observe` between turns. A turn smaller than one step (for example `0.1`
on that control) may not register.

### How success is judged

The focused control is the innermost focused element with an accessible value (for example SwiftUI
`.accessibilityValue`), or the one valued element inside a focused view that does not scroll. When
the app reports no focused element, as with SwiftUI `digitalCrownRotation`, it is the app's one
valued control outside scrolling content.

- With a readable focused value before and after, that value must change for success.
- Otherwise any hierarchy change counts as success. An unrelated update, such as a status label,
  can satisfy it, so success does not confirm that the crown moved the control.
- Without a readable focused value, the tool first touches an interior point clear of elements to
  wake crown routing. Content absent from the hierarchy, such as a canvas that handles taps, can
  still receive that touch. To avoid it, tap the control that should respond first.
- If nothing changes, it may wake again and retry once. That needs a stable screen and an unchanged
  readable focused value. After an initial wake it never repeats the turn without a comparable value.
- Without a stable hierarchy, it compares the last pre-rotation value with the post-rotation value,
  without waking or retrying. If either is unavailable, it skips verification.

When a rotation changes nothing, the error says which case applies:

- **The focused value stayed the same**: the error quotes it (`value stayed "10"`). The turn was too
  small, or the control is at its limit. It is at its limit only when the value already sits at the
  end the turn heads toward, such as `"10"` after a positive `delta` on a 0–10 control. Otherwise,
  including `"0"` after a positive `delta`, retry with a larger `delta` in the same direction.
- **No focused control exposes a readable value**: no view may hold crown focus, or the scrolled
  content is at its limit. Tap the control first. For a `delta` between -1 and 1, the error also
  says the turn may be too small.

Use `observe` after rotating to confirm the app responded. Retry only if `observe` confirms the
turn had no effect, because a retry after a working turn can overshoot. Tap the control that should
respond before retrying.

## sendKeys

`sendKeys` accepts non-empty text only and appends to the focused field. Focus a field with `tapOn`
first, or pass a selector with an exact `elementId` or `text`. Selector `text` matches a field's
label, value or placeholder, and prefers text fields over static text. A focused field opens the
watch keyboard, and AutoMobile types through it. Input fails when no text field or keyboard is up.
The watch refuses commands that clear, replace or press keys.

## postNotification

`postNotification` sends a simulated push to the watch app named by `appId`. The simulator cannot
pre-grant notification authorization, so the app must request permission. Answer Allow with
`tapOn`, scrolling with `rotateCrown` or `swipeOn` first if needed. Use `observe` to find Allow /
Don't Allow. A "CtrlProxyWatch" permission prompt may appear first.

- If the watch dropped the push because the app's notifications are denied, `postNotification`
  returns `success: false`. That happens after Don't Allow, or when Allow was never reached.
- The watch does not ask a denied app again. Uninstall and reinstall it (`installApp` resets its
  permissions), launch it, answer Allow, then post again.
- When no delivery verdict is available, success means the simulator accepted the push.
- A banner disappears after a few seconds. Call `observe` right after the push to inspect its short
  look; the long look exposes its action buttons.

## App management

- `installApp` takes a watch simulator `.app` bundle.
- `uninstallApp` refuses `keepData: true`.
- `launchApp` reports an app that is not installed without launching anything. It refuses
  `prototype: true`. With `clearAppData`, it wipes the app's Documents, Library and tmp before
  launch. It does not observe the launched app, so `verified` stays unset with
  `verificationSkipped: "platform"`.
- `terminateApp` succeeds with `wasRunning: false` when the app was not running.
- `crashApp` sends SIGABRT to the running watch app named by `appId`, as on an iOS simulator. It
  checks the watch's unified log and the host crash reports for fresh crash evidence. The result has
  `confirmed`, `evidence` and, when it finds the report, a `crashReport` summary. An app that is not
  running fails with `wasRunning: false`, and AutoMobile signals nothing.

To refresh a widget on demand, make the host app reload its widget timelines when it sees a launch
argument you choose. Then call `terminateApp` and `launchApp` with that argument, for example
`launchArguments: ["-reload"]`. The widget shows the new content within about 2 seconds, with no
tap in the host app.

## getLogs

`getLogs` reads the watch simulator's unified log as on an iOS simulator. Enable it with
`setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)).

| Parameter                          | Watch behavior                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`                            | Required. Returns lines from the app's subsystem or its process                                                                       |
| `minPriority`                      | `V`/`D` debug and up, `I` info and up, `W` default and up (the unified log has no warning level), `E` error and fault, `F` fault only |
| `tags`, `buffers`, `includeSystem` | Android-only; ignored with a warning                                                                                                  |

## executePlan

`executePlan` replays a plan on a watch with `platform: "watchos"`, including a plan that
`recordToolCalls` recorded on a watch. Each step runs as the same tool called directly. A step whose
tool does not accept a watch fails with the standard refusal. Plans on a watch record no video.

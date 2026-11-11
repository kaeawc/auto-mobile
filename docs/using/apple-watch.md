# Apple Watch simulators

AutoMobile can drive an Apple Watch simulator as its own platform, `platform: "watchos"`. Only a
fixed set of tools accept a watch; every other tool refuses it. This page covers setting a watch
up, the supported tools and what is out of scope.

## Supported watches

- Simulators only. A physical Apple Watch is not supported.
- Standalone and companion watch apps. Pair a watch with an iPhone simulator using `startDevice`
  with `pairWithDeviceId`.
- Any Apple Watch device type and watchOS runtime installed in Xcode. Install a missing runtime
  with `xcodebuild -downloadPlatform watchOS`; AutoMobile never downloads one.

A watch never appears in an iOS listing or iOS tool result. Every watch call names it with
`platform: "watchos"`. `startDevice` with `platform: "ios"` and a watch UDID fails with
`Device '<UDID>' is a watchOS simulator, not an iOS simulator`, naming `platform: "watchos"`.

## List, create and boot a watch

Read the `automobile:devices/images/watchos` resource. It lists existing watch simulators
(`watchosCount`) and the catalog of installed watchOS runtimes and Apple Watch device types.
`listDevices` with `platform: "watchos"` lists the booted watches.

Create a watch with `provisionDevice`, passing exact identifiers from that catalog:

```json
{
  "name": "provisionDevice",
  "arguments": {
    "device": {
      "platform": "watchos",
      "name": "Test Watch",
      "spec": {
        "runtime": "com.apple.CoreSimulator.SimRuntime.watchOS-11-0",
        "deviceType": "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm"
      }
    },
    "boot": true
  }
}
```

A watch with that name (and `deviceId`, if given) and the same runtime and device type is reused.
A new watch is created only when no watch has that name, no `deviceId` is given and device
creation is enabled. Two watches with the same name need `deviceId`. A watch with
that name but a different runtime or device type is an error: use another name, or delete that
watch first. A missing `spec` or field, or an identifier the host does not list, is refused with
an example and the accepted identifiers. `resources`, `enableTools` and `readiness: "automation"`
are refused.

Boot an existing watch and start a session with `startDevice`, naming it by exact UDID or exact
name. Optional `timeoutMs` bounds startup; `pairWithDeviceId` names an iPhone simulator UDID.

```json
{ "name": "startDevice", "arguments": { "platform": "watchos", "deviceId": "<watch UDID>" } }
```

With `pairWithDeviceId`, the watch is paired and the pair activated before boot. The phone is
never booted by this call: boot it separately with `startDevice`, `platform: "ios"`.
The result includes `pair` with `pairId`, `state` (`active` or `inactive`), `connection`
(`connected` or `disconnected`), `phoneDeviceId`, and `created`. `created: false` means an
existing pair was reused. Connection is sampled after watch boot and may still be disconnected.
If `startDevice` fails after pairing, a pair it created is unpaired again; a reused pair is kept.
A watch already paired to another phone is refused with its pair ID and phone name/UDID:
unpair it first or pass that phone. A missing or non-iOS simulator UDID is refused; choose an
iPhone simulator from the device images. One phone may have several watches.

`listDevices` for `ios`, `watchos` or no platform includes `simulatorPairs` when pairs are available. Each
entry has `pairId`, `state`, `connection`, and `watch`/`phone` objects with `deviceId`, `name`,
and device `state`. Pair information is omitted if none exist or the pair listing fails.
Deleting a watch automatically unpairs only pairs created by the current daemon.

`startDevice` also starts the watch automation runner. If the runner cannot start, the session is
still bound at readiness `booted`, the response message says why, and `observe` returns a
screenshot only. From an AutoMobile checkout, `startDevice` builds the runner itself when the
checkout is the directory AutoMobile was started from, or is named by `AUTOMOBILE_PROJECT_ROOT`;
the response message lists every location checked and the build command when it cannot find the
project. Set `AUTOMOBILE_WATCH_RUNNER_XCTESTRUN` to a prebuilt runner when using the published
package (see [Environment variables](environment-variables.md)).

To pick a watch for a connection without a session, call `setActiveDevice` with
`platform: "watchos"`. A call that does not name `watchos` never reaches a watch.

Stop a watch with `killDevice` (`platform: "watchos"` and its UDID) and delete it with
`deleteDevice` (`target.platform: "watchos"`, UDID as `target.stableId`). See
[Device ownership](device-ownership.md#stopping-a-held-device-killdevice-and-deletedevice).

## Supported tools

Besides the device management above, these tools accept a watch:

<!-- watchos-supported-tools:start -->

- `observe`
- `tapOn`
- `tapAt`
- `sendKeys`
- `swipeOn`
- `pressButton`
- `rotateCrown`
- `postNotification`
- `installApp`
- `uninstallApp`
- `listApps`
- `launchApp`
- `terminateApp`
- `getLogs`
- `executePlan`

<!-- watchos-supported-tools:end -->

Every other tool refuses a watch before doing anything, with:

```text
<tool> does not support watchOS yet. Target an Android or iOS device instead.
```

### What each tool does on a watch

- `observe` returns a screenshot. With the automation runner connected it also returns the target
  app's view hierarchy and on-screen system alerts, including the notification permission prompt,
  notification short look and long look with action buttons, even when the app is not in the
  foreground. If the hierarchy cannot be read, the result carries `hierarchyUnavailable` and no
  hierarchy fields. When the runner is connected but the target app is not in the foreground,
  the message says to call `launchApp` to bring it back, or post a notification and retry
  `observe`; read the screenshot meanwhile. With a hierarchy, bounds and `screenSize` are in
  points and `screenshotImageSize` is in pixels; a screenshot-only result reports `screenSize` in
  pixels. Check `screenSize.units` (`points` or `physical-pixels`) before using it for `tapAt`,
  which takes points. With the runner connected, an element `waitFor` re-reads the hierarchy until
  it matches or `timeout` elapses; `waitFor` with `for`, `posture`, `activeDisplay` or
  `activeWindow`, and `waitFor` without a runner, are refused. `settled`, `raw`, `includeExtras`,
  `scope`, `layer`, `skipBackStack`, `crop`, `screenshotOptions` and `screenshot: "none"` are
  refused.
- `tapOn` takes a `selector` with an exact `elementId` or `text`, and an optional `index`. Only
  elements wholly on screen match, including notification action buttons. Only `action: "tap"`
  is supported. The notification permission prompt scrolls: use `rotateCrown` to bring `Allow`
  wholly into view before selecting it with `tapOn`. When the Smart Stack is open and the host
  app is not foreground, `tapOn` matches a widget's exact text or cell identifier on the watch face.
  Only cards wholly on screen match: text that only an off-screen widget shows is refused, with a
  hint to scroll the Smart Stack first.
- `tapAt` takes absolute coordinates in points, including for widgets when the Smart Stack is open.
  Tapping a widget with `tapOn` or `tapAt` opens its host app, so the normal tools work afterwards.
  While the Smart Stack is open, `observe` returns `hierarchyUnavailable` and no hierarchy fields.
  With the host app not in the foreground and no Smart Stack open, `tapAt` taps the watch face
  at the given point coordinates; `tapOn` still needs the host app foreground. Whether such a tap
  opens a complication has not been checked on a device, so `observe` afterwards to confirm the
  result. A point outside the watch screen fails with `tap is outside the watch screen`; take the
  coordinates from `observe`, within `screenSize`.
- `swipeOn` swipes in a direction. With `lookFor` it swipes until an exact `text` or `elementId`
  is on screen, up to `maxSwipes` (default 10, maximum 100). Each `lookFor` step is a short, slow drag (about
  one row on a list) so consecutive reads overlap and nearby targets are not skipped. Coordinates
  and duration cannot be set.
- `pressButton` supports `home` only.
- `rotateCrown` turns the Digital Crown by a signed, non-zero `delta`, with an optional positive
  `velocity` (default 1). `delta` is measured in full crown revolutions: `1` is one complete turn,
  `0.25` a quarter turn, and the sign sets the direction. How far a turn moves a control depends on
  the app's crown binding (step size and sensitivity), so one revolution can cross a whole small
  control: on a 0–10 control with step 1 and medium sensitivity, `0.25` moves about 3 steps, `0.5`
  about 7, and `1` reaches the end. To reach an intermediate value, use fractional deltas and
  `observe` between turns. A turn smaller than one step of the focused control (for example `0.1`
  on that control) may not register. When a rotation changes nothing, the error says which case
  applies:
  - The focused control's value stayed the same: the error quotes that value (`value stayed "10"`).
    Either the turn was too small to reach the next step or the control is at its limit. It is at
    its limit only when the value is already at the end the turn heads toward (for example
    `"10"` after a positive `delta` on a 0–10 control); otherwise, including `"0"` after a
    positive `delta`, retry with a larger `delta` in the same direction.
  - No focused control exposes a readable value: no view may hold crown focus, or the scrolled content
    is at its limit. Tap the control first. When `delta` is between -1 and 1, the error also says
    the turn may be too small.

  It is not listed by default; enable it with `setToolEnabled` (see
  [Dynamic Tools](dynamic-tools.md)). When the same focused control has a readable accessible value
  before and after a rotation, that value must change for success. Otherwise, any screen hierarchy
  change counts as success. When no focused value is readable, an unrelated update, such as a status
  label, can satisfy this condition; success does not confirm that the crown moved the control.
  Without a readable focused value, it first touches an interior point clear of elements in the
  accessibility hierarchy to wake crown routing, then rotates. Content absent from that hierarchy,
  such as a canvas that handles taps, can still receive the wake touch. To avoid this, tap the control
  that should respond first. If nothing changes, it may wake again and retry once; this requires a stable screen
  and an unchanged readable focused value, both preserved by the wake. Without a safe touch point it
  rotates without waking; after an initial wake, it never repeats the turn without a comparable value.
  If it still changes nothing or a safe retry is unavailable, it fails. Without a stable hierarchy,
  it compares the focused value from the last pre-rotation observation with the same control after rotating,
  without waking or retrying; if either value or the post-rotation snapshot is unavailable, verification is skipped.
  Use `observe` after rotating to confirm the app responded. Retry
  only if `observe` confirms the turn had no effect: if the first turn changed the control but
  verification failed, retrying can overshoot. Tap the control that should respond to the Digital
  Crown before retrying `rotateCrown`.

  ```json
  { "name": "rotateCrown", "arguments": { "platform": "watchos", "delta": 2 } }
  ```

- `installApp` takes a watch simulator `.app` bundle. `uninstallApp` refuses `keepData: true`.
- `postNotification` sends a simulated push to the watch app named by `appId`. The simulator
  cannot pre-grant notification authorization (`simctl privacy` refuses it on watchOS): the app
  must request permission, and you answer the prompt with `tapOn`, scrolling with `rotateCrown`
  first if needed. A notification banner disappears after a few seconds, so call `observe`
  immediately after the push to inspect its short look; the long look exposes its action buttons.
- `launchApp` reports an app that is not installed without launching anything. `prototype: true`
  is refused. `clearAppData` wipes the app's Documents, Library and tmp before launch. It does not
  observe the launched app: `verified` stays unset with `verificationSkipped: "platform"`.
- `terminateApp` succeeds with `wasRunning: false` when the app was not running.
- `getLogs` reads the watch simulator's unified log as on an iOS simulator: `appId` is required,
  and lines from the app's subsystem or its process are returned. `minPriority` ranks the
  unified-log levels as `V`/`D` debug and up, `I` info and up, `W` default and up (the unified log
  has no warning level), `E` error and fault, and `F` fault only. `tags`, `buffers` and
  `includeSystem` are Android-only and are ignored with a warning. It is not listed by default;
  enable it with `setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)).
- `executePlan` replays a plan on a watch with `platform: "watchos"`, including a plan
  `recordToolCalls` recorded on a watch. Each step runs as the same tool called directly, so a
  step whose tool is not in the list above fails with the refusal below. Plans on a watch record
  no video.

`sendKeys` accepts non-empty text only and appends to the focused field. Focus a field with
`tapOn` first, or provide a selector with an exact `elementId` or `text` to focus it before typing.
Selector `text` matches a field's label, value or placeholder; matching text fields are preferred over static text.
On watchOS a focused field opens the keyboard, and the text is typed through that keyboard. Input
fails when no text field or keyboard is up. Commands that clear, replace or press keys are refused.

## Limits

- No physical Apple Watch and no paired iPhone (see above).
- The automation runner reads the view hierarchy of one target app at a time, plus on-screen system
  alerts and notifications. It starts on its own
  bundled watch app; `launchApp` restarts it targeting the launched app, and fails with the reason
  if that restart fails even though the app itself launched. A runner AutoMobile did not start
  keeps its target. Other apps' own elements are unavailable to `observe`, `tapOn` and `swipeOn`
  with `lookFor`; on-screen system alerts and notifications remain available.
- No pinch, multi-touch or drag.
- Prototypes do not run on a watch. To mock up a watch screen, use a watch-sized prototype spec on a
  phone instead (see [Watch-sized mockups](../tools.md#watch-sized-mockups)).

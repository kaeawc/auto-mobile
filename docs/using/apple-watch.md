# Apple Watch simulators

AutoMobile can drive an Apple Watch simulator as its own platform, `platform: "watchos"`. Only a
fixed set of tools accept a watch; every other tool refuses it. This page covers setting a watch
up, the supported tools and what is out of scope.

## Supported watches

- Simulators only. A physical Apple Watch is not supported.
- Standalone watch apps only. AutoMobile never pairs a watch with an iPhone simulator, so flows
  that need a companion iPhone app cannot be tested.
- Any Apple Watch device type and watchOS runtime installed in Xcode. Install a missing runtime
  with `xcodebuild -downloadPlatform watchOS`; AutoMobile never downloads one.

A watch never appears in an iOS listing or iOS tool result. Every watch call names it with
`platform: "watchos"`.

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
name. Every other option is refused.

```json
{ "name": "startDevice", "arguments": { "platform": "watchos", "deviceId": "<watch UDID>" } }
```

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

<!-- watchos-supported-tools:end -->

Every other tool refuses a watch before doing anything, with:

```text
<tool> does not support watchOS yet. Target an Android or iOS device instead.
```

### What each tool does on a watch

- `observe` returns a screenshot. With the automation runner connected and the runner's target
  app in the foreground it also returns the view hierarchy; otherwise the result carries
  `hierarchyUnavailable` and no hierarchy fields. With a hierarchy, bounds and `screenSize` are in
  points and `screenshotImageSize` is in pixels; a screenshot-only result reports `screenSize` in
  pixels. Check `screenSize.units` (`points` or `physical-pixels`) before using it for `tapAt`,
  which takes points. `waitFor`, `settled`, `raw`, `includeExtras`, `scope`,
  `layer`, `skipBackStack`, `crop`, `screenshotOptions` and `screenshot: "none"` are refused.
- `tapOn` takes a `selector` with an exact `elementId` or `text`, and an optional `index`. Only
  elements wholly on screen match. Only `action: "tap"` is supported.
- `tapAt` takes absolute coordinates in points.
- `swipeOn` swipes in a direction. With `lookFor` it swipes until an exact `text` or `elementId`
  is on screen, up to `maxSwipes` (default 10, maximum 100). Coordinates and duration cannot be set.
- `pressButton` supports `home` only.
- `rotateCrown` turns the Digital Crown by a signed, non-zero `delta`, with an optional positive
  `velocity` (default 1). It is not listed by default; enable it with `setToolEnabled` (see
  [Dynamic Tools](dynamic-tools.md)).

  ```json
  { "name": "rotateCrown", "arguments": { "platform": "watchos", "delta": 2 } }
  ```

- `installApp` takes a watch simulator `.app` bundle. `uninstallApp` refuses `keepData: true`.
- `launchApp` reports an app that is not installed without launching anything. `prototype: true`
  is refused. `clearAppData` wipes the app's Documents, Library and tmp before launch.
- `terminateApp` succeeds with `wasRunning: false` when the app was not running.

`sendKeys` accepts non-empty text only and appends to the focused field. Focus a field with
`tapOn` first, or provide a selector with an exact `elementId` or `text` to focus it before typing.
On watchOS a focused field opens the keyboard, and the text is typed through that keyboard. Input
fails when no text field or keyboard is up. Commands that clear, replace or press keys are refused.

## Limits

- No physical Apple Watch and no paired iPhone (see above).
- The automation runner reads the view hierarchy of one target app at a time. It starts on its own
  bundled watch app; `launchApp` restarts it targeting the launched app, and fails with the reason
  if that restart fails even though the app itself launched. A runner AutoMobile did not start
  keeps its target. For any app other than the runner's target, `observe` is screenshot-only and
  `tapOn` and `swipeOn` with `lookFor` cannot match elements.
- No pinch, multi-touch or drag.
- Prototypes do not run on a watch. To mock up a watch screen, use a watch-sized prototype spec on a
  phone instead (see [Watch-sized mockups](../tools.md#watch-sized-mockups)).

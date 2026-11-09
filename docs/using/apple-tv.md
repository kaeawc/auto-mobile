# Apple TV simulators

AutoMobile can list, create, boot and drive an Apple TV simulator. Apple TV apps are driven by
focus and the Siri Remote, not touch. This guide covers the supported tools, focus navigation,
installing a tvOS runtime, and what is out of scope.

> Name the platform on every call: `platform: "tvos"`, or the `sessionUuid` of an Apple TV
> session. A call that names no platform never lands on an Apple TV.

## Install a tvOS runtime

AutoMobile never downloads simulator runtimes. Install one with Xcode first:

```bash
xcodebuild -downloadPlatform tvOS
```

tvOS 26.5 and tvOS 27.0 simulators are supported.

The `automobile:devices/images/tvos` resource lists the installed tvOS runtimes, the Apple TV
models and which runtimes each model supports, along with the configured Apple TV simulators. A `provisionDevice` request that names a missing or
unavailable runtime fails, lists the available runtimes and repeats the install command.

## Supported tools

<!-- apple-tv-supported-tools:start -->

| Tool                | On an Apple TV                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `listDevices`       | Lists booted Apple TV simulators.                                                                       |
| `listDeviceImages`  | Lists configured Apple TV simulators.                                                                   |
| `provisionDevice`   | Adopts or creates an exact simulator, and boots it unless `boot: false`.                                |
| `startDevice`       | Boots an existing simulator by `deviceId` or `name` and starts its runner.                              |
| `setActiveDevice`   | Selects an Apple TV only when the call passes `platform: "tvos"`.                                       |
| `killDevice`        | Shuts the simulator down and stops its runner.                                                          |
| `deleteDevice`      | Deletes the simulator.                                                                                  |
| `installApp`        | Installs a `.app` bundle built for the tvOS simulator.                                                  |
| `uninstallApp`      | Uninstalls an app.                                                                                      |
| `listApps`          | Lists installed apps.                                                                                   |
| `launchApp`         | Launches an app without observing it (`verificationSkipped: "platform"`); `prototype: true` is refused. |
| `terminateApp`      | Terminates an app.                                                                                      |
| `observe`           | Returns a screenshot, plus the hierarchy and `focusedElement` with a runner.                            |
| `pressButton`       | Presses a Siri Remote button.                                                                           |
| `tapOn`             | Moves focus to a matched element and selects it.                                                        |
| `focusNavigate`     | Moves focus to a matched element; selects it only with `select: true`.                                  |
| `sendKeys`          | Types text into the focused field.                                                                      |
| `videoRecording`    | Records the screen; `audio` is not supported.                                                           |
| `compareScreenshot` | Compares the full screen; `target` and `mask` need a runner (see below).                                |
| `explore`           | Crawls the foreground app by focus and records its screens.                                             |
| `executePlan`       | Replays a plan of Apple TV steps.                                                                       |
| `openLink`          | Opens a URL with the app that declares its scheme.                                                      |
| `getDeepLinks`      | Lists the URL schemes an installed app declares.                                                        |
| `homeScreen`        | Presses the Siri Remote `home` button.                                                                  |
| `postNotification`  | Sends a simulated push to an app; `appId` is required.                                                  |
| `setAppPermissions` | Grants, revokes or resets privacy permissions; the result is not read back.                             |

<!-- apple-tv-supported-tools:end -->

Every other device tool refuses an Apple TV with an error naming the tool. `tapAt`, `swipeOn`,
`pinchOn`, `multiTouch`, `dragAndDrop` and `tapAny` refuse it as a touch gesture and point to
focus navigation. `displayConfig`, `statusBar`, `clipboard` and `getAppPermissions` refuse it as
not available on tvOS: the tvOS simulator has no appearance or content size setting, status bar
override, pasteboard or permission read-back.

## Create and start an Apple TV simulator

`provisionDevice` takes the simulator's exact `name`, an optional `deviceId` (UDID), and the
runtime and device type identifiers from `automobile:devices/images/tvos`:

```json
{
  "device": {
    "platform": "tvos",
    "name": "tv-4k",
    "spec": {
      "runtime": "com.apple.CoreSimulator.SimRuntime.tvOS-26-5",
      "deviceType": "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-4K"
    }
  }
}
```

- An exact match is adopted; otherwise a simulator is created. Creation must be allowed; see
  `AUTOMOBILE_ALLOW_DEVICE_CREATE` in [Environment variables](environment-variables.md).
- A name clash, a `deviceId` that names no Apple TV, or an incompatible runtime and model is refused.
  A missing `spec` or field, or an identifier the host does not list, is refused with an example
  and the accepted identifiers; a short form such as `Apple-TV-4K-3rd-generation-4K` names the full one.
- With `boot` (the default) the simulator boots and a session binds at readiness `booted`. A
  simulator the call created is deleted again if booting or binding fails; if that deletion fails,
  the error says so and tells you to delete it with `deleteDevice`.
- `boot: false` creates or adopts the simulator without a session.
- `resources`, `enableTools` and `readiness: "automation"` are refused.

`startDevice { platform: "tvos", name: "tv-4k" }` boots an existing simulator, starts its automation
runner and binds a session. It never creates a simulator; a name or `deviceId` that matches none,
or more than one, fails and asks for an exact `deviceId`.

On first tvOS use, AutoMobile downloads and verifies the release’s prebuilt runner; no source
checkout is needed. `AUTOMOBILE_TVOS_RUNNER_XCTESTRUN` selects an explicit `.xctestrun` instead.
Existing local build products take precedence over the download. If the selected release has no
runner checksum, use the override or a source checkout to build one. If the runner cannot start, the
call still returns a booted session and `message` explains why. Call `startDevice` again after
fixing the cause.

## Lifecycle

| Step       | Call                                                          |
| ---------- | ------------------------------------------------------------- |
| Detect     | `listDevices` or `listDeviceImages` with `platform: "tvos"`   |
| Create     | `provisionDevice` with `device.platform: "tvos"`              |
| Start/boot | `startDevice { platform: "tvos", name }` or `provisionDevice` |
| Shut down  | `killDevice`                                                  |
| Delete     | `deleteDevice` (below)                                        |

`deleteDevice` requires `mode: "destroy"` and `verifyAbsence: true`:

```json
{
  "target": { "platform": "tvos", "isVirtual": true, "stableId": "<UDID>" },
  "mode": "destroy",
  "verifyAbsence": true
}
```

It stops a running simulator and releases its session first. An absent UDID returns
`already_absent`; a mismatched `target.stableName` fails with `identity_conflict`, and an
unsuccessful deletion with `tv_delete_failed`. Releasing the session, killing or deleting the simulator stops its runner.

Check inventory completeness before treating an empty listing as no devices, and retry a failed
listing.

## Observe

With a connected runner, `observe` returns a screenshot, the hierarchy and `focusedElement`;
`project: "full"` includes the full hierarchy. The hierarchy describes the app in front: the app
you last started with `launchApp`, Settings or another Apple app, or the home screen.

Without a runner it returns a screenshot with `hierarchyUnavailable`; call `startDevice` again to
prepare automation. A runner that does not answer a command within 5 seconds is disconnected:
`observe` then returns a screenshot with `hierarchyUnavailable` and the reason in its `message`
(`project` and `waitFor` are refused), and `pressButton`, `tapOn` and `sendKeys` fail at once,
asking you to call `startDevice` to restart the runner. With a runner, `waitFor`
waits for an element (`elementId`, `testTag`, `text`, `textAny`, `className`,
`contentDescription`, `absent`) by re-reading the hierarchy until it matches or `timeout` elapses;
`waitFor` with `for`, `posture`, `activeDisplay` or `activeWindow` is refused. Other advanced
observe options are refused.

## Record and compare the screen

`videoRecording` records an Apple TV simulator's screen like an iOS Simulator's, up to 3600
seconds. Focus rings, parallax and focus scaling are visible in the recording.

`compareScreenshot` records and compares named screenshot baselines. An Apple TV baseline is kept
per screenshot size; density, font scale and theme are always `null` in its profile.

- Without a runner, only the full screen is compared. A `target` or `mask` is refused; call
  `startDevice` to prepare the runner.
- With a runner, `target` and `mask` take an `elementId` or a `rect` in points, the units the
  hierarchy reports.
- Apple TV has no system bars, so `ignoreSystemBars` has no effect.

## Navigate with focus

Apple TV apps have no touch input. Focus moves between elements, and the Siri Remote selects the
focused one.

`pressButton` presses one of these remote buttons:

<!-- apple-tv-remote-buttons:start -->

`up`, `down`, `left`, `right`, `select`, `menu`, `home`, `playPause`

<!-- apple-tv-remote-buttons:end -->

`tapOn` replaces tapping: it moves focus to a matched element with directional presses and then
presses `select`.

- Match with an exact `text` or `elementId`, and an optional zero-based `index`. Only the `tap`
  action is supported; other options are refused.
- Focus must already be somewhere on screen. With nothing focused, press a direction with
  `pressButton` and observe.
- A match outside the visible area, such as an item further along a row, is still reached: focus
  moves toward it and the row scrolls. On-screen matches count first for `index`.
- When nothing on screen matches yet, focus sweeps each row right and left, moving down a row at a
  time and then up, until the match appears, for at most 60 moves.
- No match after that search, a target that disappears, focus that stops moving, or more than 30
  moves toward the target fails the call. Observe, move closer with `pressButton`, and retry.

`focusNavigate` takes the same `until`, `direction`, `maxSteps`, `settleMs` and `select`
parameters and returns the same `path`, `status` (`focused`, `max_steps` or `stuck`) and
`selected` as on Android TV. Directions are Siri Remote presses, and `select: true` presses the
remote's `select` once the target is focused; without it, activate the focused element with
`pressButton` `select`. With nothing focused it presses down first. A `label` or `elementId`
target is matched to the element `tapOn` would select.

The tvOS focus engine remembers the last focused item in each row or column, so the element a
direction reaches can depend on where focus was before. Observe again rather than predicting focus
from the layout.

## Enter text

Select a text field with `pressButton select` to open the on-screen keyboard, then call `sendKeys`
with `type` commands. Text is appended to the field. While the keyboard is open, the hierarchy
shows only each field's label; the placeholder appears only as the keyboard's prompt. Typed text
is hidden. A named plain field's typed value is readable with `observe` after the keyboard closes.
Secure fields never show their value.

- `operation: "replace"`, key commands, clear commands and selectors are refused.
- To change existing text, edit it on the on-screen keyboard with `pressButton`, then type.

## Explore an app

`explore` is available when the server runs with `--embedded-sdk`, like the other
[navigation graph](navigation-graph.md) tools; the Apple TV app itself does not need the SDK.
Without the flag, `explore` is missing from `tools/list` and a call fails with
`Unknown tool: explore. embedded SDK mode is disabled; ...`, followed by these steps:

1. Add `--embedded-sdk` to the AutoMobile MCP server command and reconnect. A running daemon
   started without it is restarted with it.
2. Enable `explore` for the session with `setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)).

Launch the app with `launchApp`, then call `explore` with `platform: "tvos"`. Explore selects
every item it can focus on a screen, observes after every remote press, records each screen a
`select` opens in the navigation graph, and presses `menu` to go back.

- It accepts `maxInteractions` (default 200), `timeoutMs` (default 300000) and `packageName`.
  `strategy`, `mode`, `resetToHome`, `resetInterval` and `dryRun` are refused.
- With `packageName`, that app must already be in the foreground.
- It stops at either limit, when the first screen has nothing left to select, or when the app
  cannot be brought back after leaving it (`stopReason`).
- A recorded transition replays as `tapOn` with the item's identifier, or its text when it has
  no identifier; going back replays as `pressButton menu`. A screen opened from an item with
  neither is still recorded, but `navigateTo` cannot replay that transition and says so.

## Run a plan

`executePlan` with `platform: "tvos"` runs plan steps that use Apple TV tools: `pressButton`,
`tapOn`, `sendKeys`, `observe` and the app tools. A step whose tool is not in the supported-tools
table fails the plan with the same error the tool returns on its own. Step `expectations` are
checked with the runner's hierarchy, as with `observe` `waitFor`. A plan may declare
`platform: tvos`, and a device in its `devices` list may use `platform: tvos`. Apple TV plans are
video-recorded like iOS plans; a recording that cannot start adds a `videoWarnings` entry and the
plan still runs.

## Open a deep link

`openLink` opens a URL on the Apple TV, such as `myapp://episode/42`, and the app that declares the
scheme shows that screen. Call `observe` afterwards to see where it landed.

- `getDeepLinks` with the app's bundle ID lists the custom URL schemes the installed app declares.
- The call fails when no installed app handles the URL. Apple TV has no web browser, so an
  `http` or `https` URL opens only if an app claims it.
- `waitFor`, `settled`, `acceptOpenAlert` and `chooserAppPackage` are refused.

## Notifications and permissions

`postNotification` sends a simulated remote push to the app named by `appId`, with the same
payload options as on an iOS Simulator. A successful result means the simulator accepted the push;
whether a banner is shown is up to the app and tvOS, so observe to check.

`setAppPermissions` takes `action` (`grant`, `revoke` or `reset`) and `permissions`, such as
`photos`, or `all` with `reset`. A permission the tvOS simulator does not have fails that entry with
the simulator's error; the others still apply. The fields `notificationsEnabled`,
`notificationPolicyAccess` and `scheduleExactAlarm` are refused. A change is reported as applied
but is not read back, and `getAppPermissions` is not available.

## Out of scope

- Physical Apple TV hardware.
- Prototypes: `launchApp` with `prototype: true` is refused, and prototype overlays are not
  supported.
- Touch gestures and long press.
- Downloading tvOS runtimes.

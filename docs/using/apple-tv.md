# Apple TV simulators

AutoMobile can list, create, boot and drive an Apple TV simulator. Apple TV apps respond to focus and
the Siri Remote, not touch.

> Name the platform on every call: `platform: "tvos"`, or the `sessionUuid` of an Apple TV
> session. A call that names no platform never lands on an Apple TV.

## Install a tvOS runtime

AutoMobile never downloads simulator runtimes. Install one with Xcode first:

```bash
xcodebuild -downloadPlatform tvOS
```

tvOS 26.5 and tvOS 27.0 simulators are supported.

The `automobile:devices/images/tvos` resource lists the installed tvOS runtimes and the Apple TV
models, with the runtimes each model supports. It also lists the configured Apple TV simulators. A
`provisionDevice` request that names a missing or unavailable runtime fails. The error lists the
available runtimes and repeats the install command.

## Supported tools

<!-- apple-tv-supported-tools:start -->

| Tool                | On an Apple TV                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `listDevices`       | Lists booted Apple TV simulators.                                                                         |
| `listDeviceImages`  | Lists configured Apple TV simulators.                                                                     |
| `provisionDevice`   | Adopts or creates an exact simulator, and boots it unless `boot: false`.                                  |
| `startDevice`       | Boots an existing simulator by `deviceId` or `name` and starts its runner.                                |
| `setActiveDevice`   | Selects an Apple TV only when the call passes `platform: "tvos"`.                                         |
| `killDevice`        | Shuts the simulator down and stops its runner.                                                            |
| `deleteDevice`      | Deletes the simulator.                                                                                    |
| `installApp`        | Installs a `.app` bundle built for the tvOS simulator.                                                    |
| `uninstallApp`      | Uninstalls an app.                                                                                        |
| `listApps`          | Lists installed apps.                                                                                     |
| `launchApp`         | Launches an app without observing it (`verificationSkipped: "platform"`); `prototype: true` is refused.   |
| `terminateApp`      | Terminates an app.                                                                                        |
| `observe`           | Returns a screenshot, plus the hierarchy and `focusedElement` with a runner.                              |
| `pressButton`       | Presses a Siri Remote button.                                                                             |
| `tapOn`             | Moves focus to a matched element and selects it.                                                          |
| `focusNavigate`     | Moves focus to a matched element; selects it only with `select: true`.                                    |
| `sendKeys`          | Types text into the focused field.                                                                        |
| `videoRecording`    | Records the screen; `audio` is not supported.                                                             |
| `compareScreenshot` | Compares the full screen; `target` and `mask` need a runner (see below).                                  |
| `explore`           | Crawls the foreground app by focus and records its screens.                                               |
| `executePlan`       | Replays a plan of Apple TV steps.                                                                         |
| `openLink`          | Opens a URL with the app that declares its scheme.                                                        |
| `getDeepLinks`      | Lists the URL schemes an installed app declares.                                                          |
| `homeScreen`        | Presses the Siri Remote `home` button.                                                                    |
| `postNotification`  | Sends a simulated push to an app; `appId` is required.                                                    |
| `setAppPermissions` | Grants, revokes or resets privacy permissions; the result is not read back.                               |
| `getLogs`           | Reads app logs; `appId` is required. Android-only filters are ignored with a warning.                     |
| `crashApp`          | Crashes a running app and checks for fresh crash evidence; returns a crash report summary when available. |

<!-- apple-tv-supported-tools:end -->

Every other device tool refuses an Apple TV with an error naming the tool.

- `tapAt`, `swipeOn`, `pinchOn`, `multiTouch`, `dragAndDrop` and `tapAny` refuse it as a touch
  gesture and point to focus navigation.
- `displayConfig`, `statusBar`, `clipboard` and `getAppPermissions` refuse it as not available on
  tvOS. The tvOS simulator has no appearance or content size setting, status bar override,
  pasteboard or permission read-back.

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

| Input or case                                                                 | Behavior                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact match exists                                                            | Adopts it; otherwise creates a simulator. Creation must be allowed; see `AUTOMOBILE_ALLOW_DEVICE_CREATE` in [Environment variables](environment-variables.md) |
| Name clash, `deviceId` that names no Apple TV, incompatible runtime and model | Refused                                                                                                                                                       |
| Missing `spec` or field, identifier the host does not list                    | Refused with an example and the accepted identifiers; a short form such as `Apple-TV-4K-3rd-generation-4K` names the full one                                 |
| `boot` (default `true`)                                                       | Boots the simulator and binds a session at readiness `booted`                                                                                                 |
| Boot or binding fails                                                         | Deletes a simulator the call created; if that deletion fails, the error says so and tells you to use `deleteDevice`                                           |
| `boot: false`                                                                 | Creates or adopts the simulator without a session                                                                                                             |
| `enableTools`                                                                 | Enables the named tools for the new session, as on iOS; requires `boot`                                                                                       |
| `readiness: "automation"` (with `boot`)                                       | Also starts the automation runner; `readiness` is `automation_ready`, or `runner_unavailable` with the reason in `message`                                    |
| `readiness: "none"` (default)                                                 | Starts no runner                                                                                                                                              |
| `resources`                                                                   | Refused                                                                                                                                                       |

`startDevice { platform: "tvos", name: "tv-4k" }` boots an existing simulator, starts its automation
runner and binds a session. It accepts `enableTools` too. It never creates a simulator. A name or
`deviceId` that matches none, or more than one, fails and asks for an exact `deviceId`.

Starting the runner brings its own host app to the front. AutoMobile then brings an app you launched
with `launchApp` back to the foreground, including after an automatic restart. The call returns
once the runner sees that app in front, waiting up to 5 seconds. If the restore fails or times out,
the runner still works and `message` says the app may not be in front. Call `observe` again, or
`launchApp` to bring the app back.

### The automation runner

On first tvOS use, AutoMobile downloads and verifies the release’s prebuilt runner; you need no
source checkout. `AUTOMOBILE_TVOS_RUNNER_XCTESTRUN` selects an explicit `.xctestrun` instead. Local
build products take precedence over the download. If the selected release has no runner checksum,
use the override or build one from a source checkout.

- If the runner cannot start, the call still returns a booted session and `message` explains why.
- If a runner started for the session later disconnects, the next call restarts it automatically.
- If initial startup or automatic recovery fails, fix the cause and call `startDevice` again.

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

It stops a running simulator and releases its session first.

| Result              | Cause                              |
| ------------------- | ---------------------------------- |
| `already_absent`    | The UDID is absent                 |
| `identity_conflict` | `target.stableName` does not match |
| `tv_delete_failed`  | The deletion did not succeed       |

Releasing the session, killing or deleting the simulator stops its runner.

Check inventory completeness before treating an empty listing as no devices, and retry a failed
listing.

## Observe

With a connected runner, `observe` returns a screenshot, the hierarchy and `focusedElement`;
`project: "full"` includes the full hierarchy. The hierarchy describes the app in front: the app you
last started with `launchApp`, Settings or another Apple app, or the home screen.

`focusedElement.checked` reports a toggle's on/off state when available, including when focus
belongs to the row containing the toggle. An absent `checked` means its state is unknown.

Without a runner, `observe` returns a screenshot with `hierarchyUnavailable`. Call `startDevice`, or
`provisionDevice` with `readiness: "automation"`, to prepare automation.

AutoMobile disconnects a runner that does not answer a command within 5 seconds, and reports an app
crash as an app exit. After a disconnect or crash, the next call restarts a runner AutoMobile
started for the session. If recovery fails, `observe` returns a screenshot with
`hierarchyUnavailable` and the recovery error in its `message`, and refuses `project` and `waitFor`.
Call `startDevice` to restart the runner.

| `waitFor` (runner only)                                                                | Waits until                                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `elementId`, `testTag`, `text`, `textAny`, `className`, `contentDescription`, `absent` | The hierarchy matches, re-read until `timeout` elapses             |
| `{for: "focused"}`                                                                     | An element holds focus, for example after a press or screen change |
| `{for: "focused"}` with `elementId` or `text`                                          | That element is focused                                            |

Other `for` kinds, `posture`, `activeDisplay`, `activeWindow` and other advanced observe options
are refused.

## Record and compare the screen

`videoRecording` records an Apple TV simulator's screen like an iOS Simulator's, up to 3600
seconds. Focus rings, parallax and focus scaling are visible in the recording.

`compareScreenshot` records and compares named screenshot baselines. AutoMobile keeps an Apple TV
baseline per screenshot size; density, font scale and theme are always `null` in its profile.

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

`playPause` toggles playback. Set `durationMs` to 100–10000 milliseconds to long-press any
remote button; omit it for a normal press. `steps` is unsupported. A tvOS runner built before
long-press support refuses `durationMs` with `unsupported_on_tvos`; rebuild or update the runner.

Touch-surface swipes are unavailable on tvOS. Use directional presses and focus navigation instead.

`tapOn` replaces tapping: it moves focus to a matched element with directional presses and then
presses `select`. A matched checkable control inside the focused row's bounds activates that row
with one `select`; the result's `element` remains the matched child.

- Match with an exact `text` or `elementId`, and an optional zero-based `index`. Only the `tap`
  action is supported; other options are refused.
- If focus is missing during a screen transition, `tapOn` waits up to three seconds for it to
  return. If nothing gains focus, press a direction with `pressButton` and observe before retrying.
- Focus reaches a match outside the visible area, such as an item further along a row, and the row
  scrolls. On-screen matches count first for `index`.
- When nothing on screen matches yet, focus sweeps each row right and left. It moves down a row at a
  time and then up, until the match appears, for at most 60 moves.
- The call fails when nothing matches after that search, the target disappears, focus stops moving,
  or it takes more than 30 moves toward the target. Observe, move closer with `pressButton`, and retry.

`focusNavigate` works as on [Android TV](android-tv.md#navigating-a-tv-app). It takes the same
`until`, `direction`, `maxSteps`, `settleMs` and `select` parameters. It returns the same `path`,
`status` (`focused`, `max_steps` or `stuck`) and `selected`.

- Directions are Siri Remote presses.
- `select: true` presses the remote's `select` once the target is focused. Without it, activate the
  focused element with `pressButton` `select`.
- With nothing focused, it presses down first.
- A `label` or `elementId` target matches the element `tapOn` would select.

The tvOS focus engine remembers the last focused item in each row or column. The element a direction
reaches can then depend on where focus was before, so observe again rather than predicting focus
from the layout.

## Enter text

Select a text field with `pressButton select` to open the on-screen keyboard, then call `sendKeys`
with `type` commands. `sendKeys` appends text to the field.

The hierarchy shows only each field's label, with no field values, in these cases:

- while the keyboard is open, and until about one second after AutoMobile last saw the keyboard or
  finished typing;
- briefly when first connecting;
- for longer if an unnamed text input remains.

The placeholder appears only as the keyboard's prompt. Afterwards, `observe` reads a named plain
field's typed value. Unnamed text inputs and secure fields never show their value. Whitespace-only
values are empty.

- `operation: "replace"`, key commands, clear commands and selectors are refused.
- To change existing text, edit it on the on-screen keyboard with `pressButton`, then type.

## More Apple TV tools

For exploring an app, running a plan, deep links, notifications and permissions, see
[Apple TV app tools](apple-tv-app-tools.md).

## Out of scope

- Physical Apple TV hardware.
- Prototypes: `launchApp` with `prototype: true` is refused, and prototype overlays are not
  supported.
- Touch gestures, including Siri Remote touch-surface swipes.
- Downloading tvOS runtimes.

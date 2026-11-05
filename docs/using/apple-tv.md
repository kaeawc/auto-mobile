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

The `automobile:devices/images/tvos` resource lists the installed tvOS runtimes, the Apple TV
models and which runtimes each model supports, along with the configured Apple TV simulators. A `provisionDevice` request that names a missing or
unavailable runtime fails, lists the available runtimes and repeats the install command.

## Supported tools

<!-- apple-tv-supported-tools:start -->

| Tool               | On an Apple TV                                                               |
| ------------------ | ---------------------------------------------------------------------------- |
| `listDevices`      | Lists booted Apple TV simulators.                                            |
| `listDeviceImages` | Lists configured Apple TV simulators.                                        |
| `provisionDevice`  | Adopts or creates an exact simulator, and boots it unless `boot: false`.     |
| `startDevice`      | Boots an existing simulator by `deviceId` or `name` and starts its runner.   |
| `setActiveDevice`  | Selects an Apple TV only when the call passes `platform: "tvos"`.            |
| `killDevice`       | Shuts the simulator down and stops its runner.                               |
| `deleteDevice`     | Deletes the simulator.                                                       |
| `installApp`       | Installs a `.app` bundle built for the tvOS simulator.                       |
| `uninstallApp`     | Uninstalls an app.                                                           |
| `listApps`         | Lists installed apps.                                                        |
| `launchApp`        | Launches an app; `prototype: true` is refused.                               |
| `terminateApp`     | Terminates an app.                                                           |
| `observe`          | Returns a screenshot, plus the hierarchy and `focusedElement` with a runner. |
| `pressButton`      | Presses a Siri Remote button.                                                |
| `tapOn`            | Moves focus to a matched element and selects it.                             |
| `focusNavigate`    | Moves focus to a matched element without selecting it.                       |
| `sendKeys`         | Types text into the focused field.                                           |

<!-- apple-tv-supported-tools:end -->

Every other device tool refuses an Apple TV with an error naming the tool. `tapAt`, `swipeOn`,
`pinchOn`, `multiTouch`, `dragAndDrop` and `tapAny` refuse it as a touch gesture and point to
focus navigation.

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

The runner needs a prebuilt tvOS simulator runner. Set `AUTOMOBILE_TVOS_RUNNER_XCTESTRUN` to its
`.xctestrun` file; a source checkout finds or builds one instead. If the runner cannot start, the
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
`project: "full"` includes the full hierarchy. Without a runner it returns a screenshot with
`hierarchyUnavailable`; call `startDevice` again to prepare automation. Advanced observe options
are refused.

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
- A missing match, a target that disappears, focus that stops moving, or more than 30 moves fails
  the call. Observe, move closer with `pressButton`, and retry.

`focusNavigate` moves focus without selecting. It takes the same `until`, `direction`,
`maxSteps` and `settleMs` parameters and returns the same `path` and `status` (`focused`,
`max_steps` or `stuck`) as on Android TV. Press `select` with `pressButton` to activate the
focused element. With nothing focused it presses down first.

The tvOS focus engine remembers the last focused item in each row or column, so the element a
direction reaches can depend on where focus was before. Observe again rather than predicting focus
from the layout.

## Enter text

Select a text field with `pressButton select` to open the on-screen keyboard, then call `sendKeys`
with `type` commands. Text is appended to the field.

- `operation: "replace"`, key commands, clear commands and selectors are refused.
- To change existing text, edit it on the on-screen keyboard with `pressButton`, then type.

## Out of scope

- Physical Apple TV hardware.
- Prototypes: `launchApp` with `prototype: true` is refused, and prototype overlays are not
  supported.
- Touch gestures and long press.
- Downloading tvOS runtimes.

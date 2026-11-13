# Apple Watch simulators

AutoMobile drives an Apple Watch simulator as its own platform, `platform: "watchos"`. Only a
fixed set of tools accept a watch; every other tool refuses it. This page covers setup, the
supported tools and what is out of scope.

## Supported watches

- Simulators only. A physical Apple Watch is not supported.
- Standalone and companion watch apps. Pair a watch with an iPhone simulator using `startDevice`
  with `pairWithDeviceId`.
- Any Apple Watch device type and watchOS runtime installed in Xcode. Install a missing runtime
  with `xcodebuild -downloadPlatform watchOS`; AutoMobile never downloads one.

A watch never appears in an iOS listing or iOS tool result. Every watch call names it with
`platform: "watchos"`. Calling `startDevice` with `platform: "ios"` and a watch UDID fails with
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

`provisionDevice` matches an existing watch by name (and `deviceId`, if given):

| Situation                                                                  | Result                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------- |
| A watch with that name, runtime and device type exists                     | Reused                                                |
| No watch has that name, no `deviceId` is given, device creation is enabled | Created                                               |
| Two watches share the name                                                 | Pass `deviceId`                                       |
| A watch with that name has a different runtime or device type              | Error: use another name, or delete that watch first   |
| Missing `spec` or field, or an identifier the host does not list           | Refused, with an example and the accepted identifiers |
| `resources`, `enableTools` or `readiness: "automation"`                    | Refused                                               |

### Start a session

Boot an existing watch and start a session with `startDevice`, naming it by exact UDID or exact
name. Optional `timeoutMs` bounds startup.

```json
{ "name": "startDevice", "arguments": { "platform": "watchos", "deviceId": "<watch UDID>" } }
```

To pick a watch for a connection without a session, call `setActiveDevice` with
`platform: "watchos"`. A call that does not name `watchos` never reaches a watch.

### Pair with an iPhone simulator

Pass an iPhone simulator UDID as `pairWithDeviceId`. AutoMobile pairs the watch and activates the
pair before boot. This call never boots the phone; boot it separately with `startDevice` and
`platform: "ios"`. One phone may have several watches.

The result includes `pair`:

| Field           | Value                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------- |
| `pairId`        | The pair's ID                                                                                |
| `state`         | `active` or `inactive`                                                                       |
| `connection`    | `connected` or `disconnected`, sampled after watch boot, so it may still read `disconnected` |
| `phoneDeviceId` | The phone's UDID                                                                             |
| `created`       | `false` when AutoMobile reused an existing pair                                              |

- If `startDevice` fails after pairing, AutoMobile unpairs a pair it created and keeps a reused one.
- A watch already paired to another phone is refused with its pair ID and phone name/UDID. Unpair
  it first or pass that phone.
- A missing or non-iOS simulator UDID is refused. Choose an iPhone simulator from the device images.

`listDevices` for `ios`, `watchos` or no platform includes `simulatorPairs` when pairs exist. Each
entry has `pairId`, `state`, `connection`, and `watch`/`phone` objects with `deviceId`, `name` and
device `state`. The field is absent when no pairs exist or the pair listing fails. Deleting a watch
unpairs only pairs that the running daemon created.

### The automation runner

`startDevice` also starts the watch automation runner. If the runner cannot start, the session still
binds at readiness `booted` and `observe` returns a screenshot only. The response message says why.

On first use AutoMobile downloads and verifies the release's prebuilt runner, so you need no source
checkout. Existing local build products take precedence over the download. When the release has no
watch runner checksum:

- From an AutoMobile checkout, `startDevice` builds the runner itself. The checkout must be the
  directory AutoMobile started from, or the one `AUTOMOBILE_PROJECT_ROOT` names.
- When it cannot find the project, the message lists every location checked and the build command.
- `AUTOMOBILE_WATCH_RUNNER_XCTESTRUN` selects an explicit prebuilt runner instead (see
  [Environment variables](environment-variables.md)).

### Stop and delete

Stop a watch with `killDevice` (`platform: "watchos"` and its UDID). Delete it with `deleteDevice`
(`target.platform: "watchos"`, UDID as `target.stableId`). See
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
- `crashApp`
- `getLogs`
- `executePlan`

<!-- watchos-supported-tools:end -->

Every other tool refuses a watch before doing anything, with:

```text
<tool> does not support watchOS yet. Target an Android or iOS device instead.
```

[Apple Watch tool behavior](apple-watch-tools.md) describes what each of these tools does on a
watch, including `rotateCrown`, notifications and Smart Stack widgets.

## Limits

- No physical Apple Watch, and no pairing with a physical iPhone; pair only with an iPhone simulator
  (see above).
- The automation runner reads the view hierarchy of one target app at a time, plus on-screen system
  alerts and notifications. Other apps' own elements are unavailable to `observe`, `tapOn` and
  `swipeOn` with `lookFor`.
- The runner starts on its own bundled watch app. `launchApp` restarts it targeting the launched
  app. If that restart fails, `launchApp` fails with the reason even though the app launched. A
  runner AutoMobile did not start keeps its target.
- No pinch, multi-touch or drag.
- Prototypes do not run on a watch. To mock up a watch screen, use a watch-sized prototype spec on a
  phone instead (see [Watch-sized mockups](../tools.md#watch-sized-mockups)).

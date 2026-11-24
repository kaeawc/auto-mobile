# Apple Vision Pro simulator (visionOS)

A visionOS simulator runs the same visionOS app builds as Apple Vision Pro hardware. Use it to check a visionOS app before you have a headset, and as a stand-in for Apple glasses testing. It is not glasses hardware, and it does not reproduce their sensors, cameras or display.

## Requirements

- macOS with Xcode and the visionOS SDK.
- A visionOS simulator runtime. Check that one is installed:

  ```bash
  xcrun simctl list runtimes | grep xrOS
  ```

  If nothing prints, install the runtime in Xcode under Settings, then Platforms.

## Create and boot

Use the Vision Pro 4K device type. The plain `Apple Vision Pro` entry is rejected on visionOS 26.5 with "Incompatible device".

```bash
auto-mobile --cli provisionDevice --readiness none --device '{
  "platform": "visionos",
  "name": "vision-test",
  "spec": {
    "runtime": "com.apple.CoreSimulator.SimRuntime.xrOS-26-5",
    "deviceType": "com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro-4K"
  }
}'
```

The result includes the simulator's UDID (`identity.stableId`), a `sessionId`, and `enabledTools`: the tools this session can use on visionOS. Tools that refuse visionOS, such as `pinchOn`, `tapAny` and `keyboard`, are left out. Pass that `sessionId` as `--sessionUuid` to the calls below. `readiness` must be `none` for visionOS. Provisioning boots the simulator and creates it if no exact match exists.

## Install and launch an app

Install an app built for the visionOS simulator (the `xrsimulator` SDK), as a `.app` bundle.

```bash
auto-mobile --cli installApp --platform visionos --sessionUuid "$SESSION_ID" \
  --artifactPath path/to/YourApp.app
auto-mobile --cli launchApp --platform visionos --sessionUuid "$SESSION_ID" \
  --appId com.example.yourapp
```

Replace `path/to/YourApp.app` and `com.example.yourapp` with your bundle path and bundle identifier. `launchApp` does not observe after the launch, so it leaves `verified` unset and reports `verificationSkipped: "platform"`. Run `observe` to confirm the screen.

## Observe the screen

```bash
auto-mobile --cli observe --platform visionos --sessionUuid "$SESSION_ID" --screenshot settled
```

The result contains a screenshot path. Read the screenshot to see the screen. Without the window-app runner, the result carries only the screenshot and a message that the runner is unavailable. See the limits below.

Every visionOS observe captures a screenshot, so `screenshot` accepts `"settled"` or `"async"`, not `"none"`. `raw` is not supported: omit it, and pass `project: "full"` with the runner to get every element. An observe that passes an unsupported option fails before capturing. The error names each unsupported option and what to use instead.

## Tap, swipe and press home

`tapAt` and `swipeOn` act on the app window the runner automates, in window points: the units of the element `bounds` that `observe` returns. Screenshot pixels are a different space, so read coordinates from `bounds`, not from the screenshot.

```bash
auto-mobile --cli tapAt --platform visionos --sessionUuid "$SESSION_ID" --x 640 --y 232
auto-mobile --cli swipeOn --platform visionos --sessionUuid "$SESSION_ID" --direction up
auto-mobile --cli swipeOn --platform visionos --sessionUuid "$SESSION_ID" --direction left \
  --container '{"elementId":"gallery"}' --durationMs 400
auto-mobile --cli pressButton --platform visionos --sessionUuid "$SESSION_ID" --button home
```

| Tool                        | visionOS behavior                                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tapAt`                     | One tap at absolute `x`/`y`. `action` must be `tap`. `coordinateSpace` must be `absolute` or omitted. `image`, `snapshotId`, `display`, `layer` and `pointer` are refused.                                                                                           |
| `swipeOn`                   | A straight stroke across the middle half of the app window, or of the `container` you select by `elementId` or `text` (optional `index`). Set the stroke time with `durationMs` (50–10000) or `speed`. `lookFor`, `fromEdge`, `boomerang` and `display` are refused. |
| `pressButton`, `homeScreen` | `home` presses the Digital Crown, which shows the Home View. Other buttons, `durationMs` and `steps` are refused. The result reports the press; the runner cannot read the Home View to confirm it.                                                                  |

These tools need the window-app runner, like `tapOn`. An older runner answers them with "does not support". Use the runner from the same release, or rebuild the local runner. `swipeOn` does not search: run `observe` afterwards to see where the content moved. An error for any option names the option to remove.

## Read app logs

```bash
auto-mobile --cli getLogs --platform visionos --sessionUuid "$SESSION_ID" \
  --appId com.example.yourapp --grep "detail opened"
```

`getLogs` reads the simulator's unified log for the app: lines from its `os.Logger` subsystem (`com.example.yourapp` or `com.example.yourapp.*`) or from its process.

| Parameter                          | visionOS behavior                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `appId`                            | Required.                                                                                                                              |
| `since`                            | `"lastAction"`, `"sessionStart"`, `"run-start"` (during plan execution only) or `{"seconds": N}`. Default: the last 300 seconds.       |
| `minPriority`                      | `V`/`D` debug and up, `I` info and up, `W` default and up (the unified log has no warning level), `E` error and fault, `F` fault only. |
| `tags`, `buffers`, `includeSystem` | Android-only; ignored with a warning.                                                                                                  |

`getLogs` is not listed by default; enable it with `setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)).

## List, stop and uninstall apps

```bash
auto-mobile --cli listApps --platform visionos --sessionUuid "$SESSION_ID"
auto-mobile --cli terminateApp --platform visionos --sessionUuid "$SESSION_ID" \
  --appId com.example.yourapp
auto-mobile --cli uninstallApp --platform visionos --sessionUuid "$SESSION_ID" \
  --appId com.example.yourapp
```

## Delete the simulator

Delete the simulator when you are done. Use its UDID from the provisioning result.

```bash
auto-mobile --cli deleteDevice --sessionUuid "$SESSION_ID" \
  --target '{"platform":"visionos","isVirtual":true,"stableId":"<UDID>"}' \
  --mode destroy --verifyAbsence true
```

A successful delete reports `state: destroyed` and `inventory: complete_absence_confirmed`.

## Limits

- AutoMobile cannot script gaze, pinch, head pose or immersive spaces. Simulator.app delivers them through Xcode's XROS.simdeviceui plugin, and Apple does not document its messages. XCUITest has no API for them either. Drive them by hand in the Simulator window. `pinchOn` and `multiTouch` refuse visionOS.
- `tapAt` and `swipeOn` cannot reach an ornament, because its `bounds` start at the ornament's own corner, not the window's. `observe` marks those elements with `space: "ornament"`. Tap ornament controls with `tapOn`; `swipeOn` refuses an ornament `container`.
- `observe` returns a screenshot only unless the window-app runner is available. On first use AutoMobile downloads and verifies the release's prebuilt runner; no source checkout is needed. Existing local build products take precedence over the download. If the selected release has no visionOS runner checksum, set `AUTOMOBILE_VISIONOS_RUNNER_XCTESTRUN` to a prebuilt runner (see [environment variables](environment-variables.md)) or use a source checkout. `tapOn` and `sendKeys` also need the runner.
- With the runner active, `observe` reports the accessibility hierarchy of the app you last launched with `launchApp`. That includes built-in visionOS apps such as Safari, Settings, Files, Maps and Photos. A hierarchy can take a few seconds to return.
- `hierarchyBundleId` names the app that the runner returning the hierarchy targets. It appears with the default projection too. It is absent when that runner has no target app or the hierarchy is unavailable.
- A `deviceId` read of a device another session holds reuses its running runner, so it can report an earlier app than that session's last `launchApp`. The app can also differ from the screenshot when another app was brought forward outside `launchApp`. Compare `hierarchyBundleId` with the app in the screenshot, and relaunch with `launchApp` to switch the hierarchy to the app you want.
- Provisioning accepts only `readiness: "none"` for visionOS.

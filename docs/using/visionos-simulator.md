# Apple Vision Pro simulator (visionOS)

A visionOS simulator runs the same visionOS app builds as Apple Vision Pro hardware. Use it to check a visionOS app before you have a headset, and as a stand-in for Apple glasses testing. It is not glasses hardware: it does not reproduce their sensors, cameras or display.

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

The result includes the simulator's UDID (`identity.stableId`) and a `sessionId`. Pass that `sessionId` as `--sessionUuid` to the calls below. `readiness` must be `none` for visionOS. Provisioning boots the simulator and creates it if no exact match exists.

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

- No scripted gaze or hand input, and no coordinate gestures such as tapping or swiping at a point. Gaze and pinch can only be driven interactively in the Simulator window.
- `observe` returns a screenshot only unless the window-app runner is available. The runner is not in the published package. To use a prebuilt runner, set `AUTOMOBILE_VISIONOS_RUNNER_XCTESTRUN` (see [environment variables](environment-variables.md)). `tapOn` and `sendKeys` also need the runner.
- With the runner active, `observe` reports the accessibility hierarchy of the window app last launched with `launchApp`. `hierarchyBundleId` is the bundle ID of the window app the runner automates, from the last `launchApp`, and is present with the default projection too. It is omitted when no app is registered for the device or the hierarchy is unavailable. This app can differ from the app in the screenshot when another app was brought forward outside `launchApp`. Compare `hierarchyBundleId` with the app in the screenshot, and relaunch with `launchApp` to switch the hierarchy to the app you want. Built-in visionOS apps do not yet report an accessibility hierarchy. Use screenshots for their screens. This is a known limitation and is not fixed yet.
- Provisioning accepts only `readiness: "none"` for visionOS.

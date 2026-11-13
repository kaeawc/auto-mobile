# Android XR emulators

AutoMobile can create, boot and drive an Android XR headset emulator and an Android XR glasses
emulator with the same device tools it uses for a phone. This guide covers installing the images,
the lifecycle calls, which tools work, how to navigate, and what is out of scope.

## Install the XR system images

AutoMobile never downloads system images. XR images are published on the canary channel, so pass
`--channel=3` to `sdkmanager`:

```bash
sdkmanager --list --channel=3 | grep -E "google-xr|ai-glasses"
```

Headset:

```bash
sdkmanager --channel=3 --install "system-images;android-34;google-xr;arm64-v8a"
```

Glasses:

```bash
sdkmanager --channel=3 --install "system-images;android-36;ai-glasses;arm64-v8a"
```

On an x86_64 host use `x86_64` in place of `arm64-v8a` where `sdkmanager --list --channel=3` lists it.

## Create and start a headset emulator

```bash
auto-mobile --cli startDevice --platform android --form-factor xr-headset --create-if-missing
```

As an MCP call: `startDevice { platform: "android", formFactor: "xr-headset", createIfMissing: true }`.
Creation must be allowed; see `AUTOMOBILE_ALLOW_DEVICE_CREATE` in
[Environment variables](environment-variables.md).

- Only installed `google-xr`, `android-xr-v3-playstore` and `android-xr-preview-playstore` images are
  candidates. The newest API level in range wins, then an ABI the host can run, then the tag in that
  order. `requires.playStore` picks only the Play variants.
- The AVD uses the `xr_headset_device` profile and is named `AutoMobile-android-xr-headset-<api>-<id>`
  unless you pass `name`.
- A cold boot reaches `automationReady` in about 30 seconds.
- A repeat request with `formFactor: "xr-headset"` reuses the created AVD.

## Create and start a glasses emulator

```bash
auto-mobile --cli startDevice --platform android --form-factor xr-glasses --create-if-missing
```

As an MCP call: `startDevice { platform: "android", formFactor: "xr-glasses", createIfMissing: true }`.

- Only installed `ai-glasses` images are candidates. Glasses have no Play image, so
  `requires.playStore` matches none.
- The AVD uses the `ai_glasses_device` profile (a 450×450 display) and is named
  `AutoMobile-android-xr-glasses-<api>-<id>` unless you pass `name`.
- `startDevice` boots the glasses emulator on its own. It does not create a host phone or pair the
  two, so apps are installed and launched on the glasses emulator.

With no image of the requested kind installed in range, `startDevice` fails with the exact
`sdkmanager --channel=3` command to run. If the known image's API level is outside
`minOsVersion`/`maxOsVersion`, the error asks you to widen the range instead.

## How AutoMobile recognises an XR device

A device is `xr-headset` or `xr-glasses` when its AVD uses one of the image tags above or an
`xr_headset*`, `xr_glasses_*` or `ai_glasses_*` profile. Both values appear in `listDevices` and can
be asked for in a device `requires` clause or a broker `deviceFamily`.

## Lifecycle

| Step       | Call                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| Detect     | `listDevices`                                                                           |
| Create     | `startDevice` with `formFactor: "xr-headset"` or `"xr-glasses"` and `createIfMissing`   |
| Start/boot | `startDevice { platform: "android", formFactor: "xr-headset" }`                         |
| Shut down  | `killDevice` with `device: { name, deviceId, platform }` and the holder's `sessionUuid` |
| Delete     | `deleteDevice`, or `avdmanager delete avd -n <name>`                                    |

## Navigating a headset app

Apps open as floating 2D panels in home space. At the default headset pose, the observe, tap, swipe,
`sendKeys`, `pressButton` and app management tools work, as do `getLogs` and `videoRecording`. Head
pose and view changes do not work. `observe` bounds carry
`boundsSpace: "panel"` or `"window"` and are not screenshot pixels. For each tool's result and
limits, see the [headset tool matrix](../how-it-works/plat/android/xr-headset.md#matrix).

Observe before each tap. `tapOn` with `text` or `elementId` is the most reliable way to act on a
panel; use `tapAt` only for points you read from a screenshot. When an app draws a Compose
`SpatialPanel` that does not receive display touches, `tapAt` refuses; use `tapOn` or `tapAny`.

## Navigating a glasses app

Glasses apps are driven by focus. Enable `glassesInput` and use it to move focus and click the
focused item, then call `observe` to check the result; see
[Android XR glasses input](android-xr-glasses.md). For voice input, use `injectAudioInput`.

## Out of scope

- Head pose and view changes: no command moves the headset view.
- Moved panels, more than one app panel, and immersive (full space) layouts.
- 3D content in `observe`, screenshots and input.
- Pairing a glasses emulator with a host phone.
- Glasses long press and two-finger gestures.
- Physical headsets and glasses.
- Downloading system images.

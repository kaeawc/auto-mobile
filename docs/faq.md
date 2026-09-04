# FAQ

## What does AutoMobile do?

It gives an MCP-compatible AI client tools to observe screens, interact with
apps, manage devices, create plans, and collect workflow or performance data.
See the [workflow guides](using/ux-exploration.md).

## Which devices are supported?

Android devices and emulators, plus iOS devices and simulators. Android host
support uses the Android SDK and `adb`; iOS simulator support requires macOS
and Xcode. The installer checks the available host tooling and reports missing
requirements.

## How do I see or start a device?

MCP clients can acquire a device with `getAndroid` or `getApple`; use
`listDevices` to inspect devices that are already available. The CLI also
exposes the compatibility `startDevice` command:

```bash
auto-mobile --cli listDevices
auto-mobile --cli startDevice --platform android
```

Replace `android` with `ios` when needed. `startDevice` selects or boots a
matching existing device; use `auto-mobile --cli help startDevice` for filters
and options.

## When do I pass `avdName` vs `deviceId` to `getAndroid` / `getApple`?

Both tools take two ways to name a target; pass one. For `getAndroid`, prefer
`avdName` when you want to boot or coordinate a named Android Virtual Device — it
sets the exact-name match, AVD name, and stable target AutoMobile uses for
lifecycle coordination. `deviceId` is the copy-paste-from-discovery convenience:
it works for an already-booted serial such as `emulator-5554`, and will also
fall back to cold-booting a matching AVD image by name if you pass a
defined-but-unbooted AVD name. For `getApple`, `deviceId` is an alias for
`udid`: a booted simulator's `deviceId` is its `udid`. The `deviceId` fields let
you copy the value `listDevices` and the `automobile:devices/booted/*` resources
lead with straight into the acquire call.

## What if I have more than one device?

Use `listDevices` to inspect them and `setActiveDevice` to select one. For
repeatable CLI calls, associate calls with the session UUID returned when you
acquire a device and pass it with `--session-uuid`.

## My MCP client cannot see AutoMobile. What should I do?

Run the installer again and select the intended client and configuration scope,
then restart the client. For a direct check, run:

```bash
auto-mobile --cli help
```

If the CLI is not installed, use:

```bash
bunx @kaeawc/auto-mobile@latest --cli help
```

## Does AutoMobile require root access?

No. Core automation uses normal `adb` permissions for Android and the standard
Apple development tools for iOS. Some capabilities are limited to emulators
or simulators.

## Where is AutoMobile data stored?

By default, AutoMobile stores its database, caches, snapshots, video archives,
and logs under `~/.auto-mobile`. `AUTOMOBILE_DATA_DIR` relocates temporary
artifacts used by observation, accessibility, navigation, CtrlProxy builds,
screen streaming, WebRTC, tool output, and daemon failure tracking;
`AUTOMOBILE_LOG_DIR` relocates logs. Some persistent stores retain fixed paths.
See [environment variables](using/environment-variables.md) for the exact scope.

## Does AutoMobile send my app data anywhere?

State and logs are stored locally by default. If vision fallback is enabled,
screenshots are sent to the configured model provider. Configure or disable
that feature according to your client and model-provider setup.

## How do I report a problem?

[Open a GitHub issue](https://github.com/kaeawc/auto-mobile/issues) with the
device and host details, reproduction steps, and relevant AutoMobile logs.

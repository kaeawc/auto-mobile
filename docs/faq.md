# FAQ

## What does AutoMobile do?

It gives an MCP-compatible AI client tools to observe screens, interact with
apps, manage devices, create plans, and collect workflow or performance data.
See the [workflow guides](index.md#common-workflows).

## Which devices are supported?

Android devices and emulators, plus iOS devices and simulators. Android host
support uses the Android SDK and `adb`; iOS simulator support requires macOS
and Xcode. The installer checks the available host tooling and reports missing
requirements.

## How do I see or start a device?

Use the MCP tools `listDevices` and `startDevice`, or run the CLI:

```bash
auto-mobile --cli listDevices
auto-mobile --cli startDevice --platform android
```

Replace `android` with `ios` when needed. `startDevice` selects or boots a
matching existing device; use `auto-mobile --cli help startDevice` for filters
and options.

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

By default, AutoMobile stores its database, caches, screenshots, and logs under
`~/.auto-mobile`. Set `AUTOMOBILE_DATA_DIR` to move non-log state or
`AUTOMOBILE_LOG_DIR` to move logs. See [environment variables](using/environment-variables.md)
for the complete list.

## Does AutoMobile send my app data anywhere?

State and logs are stored locally by default. If vision fallback is enabled,
screenshots are sent to the configured model provider. Configure or disable
that feature according to your client and model-provider setup.

## How do I report a problem?

[Open a GitHub issue](https://github.com/kaeawc/auto-mobile/issues) with the
device and host details, reproduction steps, and relevant AutoMobile logs.

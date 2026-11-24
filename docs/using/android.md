# Android phones and tablets

AutoMobile drives Android devices and emulators through the Android SDK and
`adb`. Install the SDK before you start; the installer reports what is missing.

## Get a device

- Call `getAndroid` to acquire a device. Pass `avdName` to boot a named Android
  Virtual Device, or `deviceId` for a device that is already running. With
  neither and no `requires`, `getAndroid` picks a phone: a running phone
  emulator first, otherwise it cold-boots a configured phone AVD. If there is no
  phone to pick, the error tells you to call `listDeviceImages` and pass one of
  the names as `avdName`. See the [FAQ](../faq.md).
- Call `listDevices` to see devices, and `listDeviceImages` to see the system
  images you can boot. See [Listing device images](device-images.md).
- A device your session holds takes calls only from that session. See
  [Device ownership](device-ownership.md).

## When `getAndroid` fails

- Right after a cold boot, `adb install` can fail with no reason while the
  package manager starts. `getAndroid` retries that install within
  `automationReadyTimeoutMs`. This covers a first install and an upgrade of an
  older CtrlProxy.
- If the call still fails after it cold-booted an emulator, the error message
  ends with `deviceLeft` and a next step:
  - `deviceLeft: shutdown`: the call is stopping the emulator it cold-booted.
  - `deviceLeft: booted`: the emulator is still running.
  - `deviceLeft: unknown`: the call could not confirm the emulator's state.
- A device that was already running before the call is left running, and the
  error does not add `deviceLeft`.
- The next step is to call `getAndroid` again with the same `avdName` (or the
  same arguments when you passed none).

## Android-only tools and features

- [Manufacturer profiles](oem-personas.md) approximate a device maker's build
  on a stock emulator.
- [App lifecycle](app-lifecycle.md) backgrounds or kills one running app, or
  sends it `onTrimMemory`.
- [Kill profiles](kill-profiles.md) simulate a device maker's background-kill
  policy for one app.
- [Seed content](seed-content.md) adds contacts, calendar events, call history
  and SMS messages.
- [Keystore state](keystore-test-state.md) and
  [Keystore metadata](keystore-metadata.md) work with the AutoMobile SDK in a
  debug build.
- [SDK capabilities](sdk-capabilities.md) report what the AutoMobile SDK in
  your app exposes.
- [Reaching a host server](port-reverse.md) lets an app on the device reach a
  server on your machine at `localhost`.

## Shared with iOS

Most tools work the same on both platforms. These guides cover both:

- [Device condition fixtures](device-condition.md)
- [Storage capabilities](storage-capabilities.md)
- [Emulator and simulator audio](emulator-audio.md)
- [Accessibility and performance audits](audits.md) and
  [Performance traces](performance-trace.md)

The **Platforms** column in [Tools](../tools.md) shows which devices each tool
drives.

## Other Android form factors

- [Android TV](android-tv.md)
- [Wear OS](wear-os.md)
- [Android Auto](android-auto.md) and
  [Android Automotive OS](android-automotive.md)
- [Android XR](android-xr.md)

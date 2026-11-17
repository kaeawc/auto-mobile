# iPhone and iPad

AutoMobile drives iOS devices and simulators. Simulator support needs macOS and
Xcode; the installer reports what is missing.

## Get a device

- Call `getApple` to acquire a simulator or device. `deviceId` is an alias for
  `udid`, so you can copy it from `listDevices`. See the
  [FAQ](../faq.md).
- A device your session holds takes calls only from that session. See
  [Device ownership](device-ownership.md) and
  [Apple simulator sessions](device-ownership-apple.md).
- The [iPhone Duo simulator](iphone-duo.md) page covers the foldable posture,
  hinge angle and screen geometry.

## Guides for iOS

Most tools work the same on Android and iOS. These guides cover iOS:

- [Device condition fixtures](device-condition.md) set the status bar, privacy
  decisions or location on a simulator.
- [Storage capabilities](storage-capabilities.md)
- [Emulator and simulator audio](emulator-audio.md)
- [Accessibility and performance audits](audits.md) and
  [Performance traces](performance-trace.md)

The **Requires** column in [Tools](../tools.md) shows which tools are limited to
one platform.

## Running on a Mac host or CI

- [iOS Simulator fleet cost](ios-simulator-fleet-cost.md) reports what booted
  simulators cost the host and whether one more fits.
- [Managed Macs and CI runners](managed-macs.md) covers approving the network
  filter on Macs nobody watches.
- [Headless host audio setup](headless-audio.md)

## Other Apple devices

- [Apple TV](apple-tv.md)
- [Apple Watch](apple-watch.md)
- [Apple Vision Pro simulator](visionos-simulator.md)

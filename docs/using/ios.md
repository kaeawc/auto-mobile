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
- [App lifecycle](app-lifecycle.md) sends a simulated memory warning to the
  foreground app on a simulator.
- [Emulator and simulator audio](emulator-audio.md)
- [Accessibility and performance audits](audits.md) and
  [Performance traces](performance-trace.md)

The **Platforms** column in [Tools](../tools.md) shows which devices each tool
drives.

## Limits

- `dragPath` and `dragAndDrop` cannot move home screen or dock icons. Synthesized
  touches open the icon's context menu but never lift it. A drag that holds at its
  start on one of these icons fails with `unsupported: "springboard_icon_drag"`,
  and no input is sent. Swipes that move right away, such as paging the home
  screen, and drags inside apps work as usual. To rearrange icons or open Split
  View, do it by hand.
- On an iPad with more than one app window on screen, the first tap into a window
  that is not focused only brings that window to the front; the control under it
  does not react. `tapOn` still reports success. Call `tapOn` again to activate the
  control. Taps in the focused window work as usual. `tapOn` taps a control in a
  window behind the focused one at a point at least 24 points clear of the focused
  window; when the control has no such point it fails and names both windows.
  Move the focused window, or tap a visible part of the other window with `tapAt`
  to focus it first.

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
- [CarPlay on iOS simulators](carplay.md)

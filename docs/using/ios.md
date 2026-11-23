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
- [Network condition](ios-network-condition.md) slows down or cuts a simulator's
  network.
- [Storage capabilities](storage-capabilities.md)
- [App lifecycle](app-lifecycle.md) sends a simulated memory warning to the
  foreground app on a simulator.
- [Emulator and simulator audio](emulator-audio.md)
- [Accessibility and performance audits](audits.md) and
  [Performance traces](performance-trace.md)

The **Platforms** column in [Tools](../tools.md) shows which devices each tool
drives.

## Dynamic Island and display backlight

On a simulator, `displayConfig` hides the Dynamic Island for layout checks and
turns the display off and on without a lock gesture:

- `dynamicIsland: "hidden"` hides the island; `"visible"` shows it again.
  Screen recordings and the Simulator window show the change; screenshots never
  include the island.
- Only models with a Dynamic Island support it: iPhone 14 Pro and later, except
  the 16e and 17e. On other models `supported.dynamicIsland` is `false` and a
  `dynamicIsland` request fails without changing anything. Use a model with an
  island.
- `backlight: false` turns the display off: the device locks and shows the dimmed
  Lock Screen. `backlight: true` lights the Lock Screen; unlock it with
  `wakeAndUnlock`.
- A read reports both under `current`. `reset: true` shows a hidden island and
  turns an off display back on.

Android and physical iOS devices refuse both fields.

## Limits

- `dragPath` and `dragAndDrop` cannot move home screen or dock icons. Synthesized
  touches open the icon's context menu but never lift it. A drag that holds at its
  start on one of these icons fails with `unsupported: "springboard_icon_drag"`,
  and no input is sent. Swipes that move right away, such as paging the home
  screen, and drags inside apps work as usual. To rearrange icons or open Split
  View, do it by hand.
- On an iPad with more than one app window on screen, the first tap into a window
  that is not focused only brings that window to the front. The control under it
  does not react, yet `tapOn` still reports success. Call `tapOn` again to activate
  the control. Taps in the focused window work as usual.
- For a control in a window behind the focused one, `tapOn` taps at a point at
  least 24 points clear of the focused window. When the control has no such point,
  `tapOn` fails and names both windows. Move the focused window, or tap a visible
  part of the other window with `tapAt` to focus it first.

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

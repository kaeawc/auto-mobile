# visionOS coordinate input and home press

- Kind: decision
- Date: 2026-11-23
- Source: #19055
- Shaped: [visionOS XCUITest capability boundary](../how-it-works/plat/visionos/xcuitest-capabilities.md)

## Context

On visionOS, AutoMobile could drive an app only through element `tapOn` and append-only
`sendKeys`; `tapAt`, `swipeOn`, `pressButton` and `homeScreen` refused the platform. Hosts that boot
Vision Pro simulators without Simulator.app, such as sim-rs, could not reach anything outside an
element tap. The issue asked for XCUICoordinate taps and drags, an XCUIDevice home press, a probe of
simulator HID touch, and the unreachable inputs recorded as limits.

## Options

- Window-app runner commands built on `XCUICoordinate` and `XCUIDevice`, as the watch runner does.
- Simulator HID touch (`IndigoHIDMessageForMouseNSEvent`, target 0x32), which needs a probe on a
  Mac before anything can depend on it.

## Decision

The window-app runner gains `request_tap_coordinates`, `request_swipe` and `request_press_home`,
with the iOS runner's wire names. Coordinates are window points, the space of observed element
frames, offset from the app frame's origin at dispatch.

- `tapAt` takes absolute taps only.
- `swipeOn` strokes the middle half of the window or of a container element, with no scrolling
  search. It refuses an ornament container, whose frame is scene-local.
- `pressButton home` and `homeScreen` press the Digital Crown and report the press without
  verifying the Home View.

The HID touch probe was not run.

## Consequences

- The four tools are on the visionOS allowlist; `pinchOn`, `multiTouch` and the rest still refuse.
- A runner from an earlier release refuses the new commands, since its handshake does not list them.
- Gaze, pinch, head pose and immersive spaces stay limits: Simulator.app sends them through Xcode's
  XROS.simdeviceui plugin, whose messages are undocumented.
- The commands were written and unit-tested on Linux; they still need a run on a Vision Pro
  simulator.

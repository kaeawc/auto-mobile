# iOS Simulator raw input through a SimulatorKit HID helper, on by default

- Kind: decision
- Date: 2026-11-23
- Source: #19118, research in #19019
- Shaped: [`tapAt`](../using/tap-at.md), [`sendKeys`](../using/send-keys.md), [Screen control](../using/screen-control.md)

## Context

Taps, swipes, hardware buttons and keys on a simulator went through CtrlProxy, the XCTest runner.
That needs a running runner and adds runner latency. The #19019 spike drove tap, swipe, pinch,
typing, Home and lock with SimulatorKit's host-side `SimDeviceLegacyHIDClient`, with no runner.
Under the same load, a tap took 0.5 ms against 438 ms through CtrlProxy, and Home took 1 ms
against 482 ms. Every tested input was delivered. The HID path has no XCTest idle wait, so a tap
sent while an app was still launching was lost once. The osascript JXA bridge cannot call the
client: its message struct holds a union the ObjC runtime cannot size. A compiled helper works,
as `ios/carplay-power` already showed.

## Options

- Default-on: the helper takes raw-coordinate input, and is also the fallback when CtrlProxy is
  down.
- Fallback-only: CtrlProxy stays the default; the helper runs only when CtrlProxy is unavailable.

## Decision

Default-on (owner, recorded on #19118). `ios/sim-hid` holds the helper and a pure `SimHidCore`
target. The daemon compiles the shipped sources with one `xcrun swiftc` call, caches the binary
by source and compiler, and keeps one helper process per simulator. The helper reads JSON commands
on stdin and answers each with a JSON ack. `tapAt` taps and long presses, `swipeAt`,
`pressButton home` and `power`, and raw `sendKeys` keys use the helper when it is running. While
it starts, CtrlProxy takes the input. When CtrlProxy cannot be reached, the call waits for the
helper instead. Element-targeted actions, double taps, `type` text, IME keys and the verified
`meta+h` shortcut stay on CtrlProxy. Landscape and upside-down screens also stay on CtrlProxy: touch rotation is
not verified yet. A touch within 3 s of an app launch waits out the rest of that window.
`AUTOMOBILE_DISABLE_IOS_SIM_HID=1` turns the helper off.

## Consequences

- HID taps skip the runner's stale-frame check and idle wait. `dispatchRoute` reports
  `simulatorHid` so a caller can tell which path ran.
- HID keys are real key input: a key with no focused field does nothing, and the result cannot
  say whether a field received it.
- The helper is a private-API client. An Xcode change can break it; then it fails to start, the
  daemon logs a warning, and CtrlProxy takes the input.
- Device verification on a booted simulator is still owed: portrait taps, swipes, Home, power and
  keys, the launch settle wait, and fallback with the runner stopped.

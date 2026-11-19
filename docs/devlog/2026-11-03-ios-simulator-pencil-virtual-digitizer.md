# iOS simulator Pencil input through a virtual HID digitizer

- Kind: decision
- Date: 2026-11-03
- Source: #13083 (probe results and owner decision, 2026-11-03), #18469
- Shaped: [Pressure, hover and stylus input](../how-it-works/plat/pressure-hover-stylus-input.md),
  [Stylus, pressure and hover injection](../how-it-works/mcp/stylus-pressure-hover-injection.md)

## Context

An earlier probe recorded the iOS simulator as a no-go for pressure and Pencil, and recommended
public `hover()` for hover. A later probe on an iPad Pro 13-inch (M5) simulator, iOS 26.5, found
both wrong. Public `hover()` sends one zero-length mouse move, which produces no hover on a
headless simulator. A mouse path with two or more `moveMouseToPoint` calls hovers every time.

backboardd drops stylus force and hover from the built-in simulator digitizer. It sets the
maximum force only for a service whose `PrimaryUsage` is 0x20, and the maximum hover height from
`MaxHoverHeight`. The built-in service has neither. A virtual HID digitizer with
`PrimaryUsage 0x20` and `MaxHoverHeight 1.0` delivers Pencil touches with force and tilt, and
Pencil hover with `zOffset` and tilt. It needs the private entitlements
`com.apple.private.hid.client.admin`, `.event-dispatch` and `.service-protected`, carried in a
`__TEXT,__entitlements` section on an ad-hoc signed binary. The private `XCPointerEventPath`
pressure selectors never produce force.

## Options

- A prebuilt simulator helper started with `simctl spawn`, independent of the XCTest runner.
- The same virtual digitizer inside the CtrlProxy iOS runner, with the entitlements on its
  simulator build.

## Decision

Build stylus and hover injection into the CtrlProxy iOS runner, not as a separate helper. Mouse
hover uses a path with at least two moves, not public `hover()`. The 2026-11-03 prototype on #13083
is the reference.

## Consequences

- The runner carries a private HID API and private entitlements on its simulator build only.
- Whether the runner's simulator build can carry the `__entitlements` section and register the
  virtual digitizer is unverified.
- Physical iPads, other runtimes and iPad models, and Pencil Pro squeeze and barrel roll are
  untested.

# Pressure, hover and stylus input research

- Kind: decision
- Date: 2026-10-18
- Source: moved from `how-it-works/plat/pressure-hover-stylus-input.md`; #12539, #13080, #13081,
  #13082, #13083, #13084
- Shaped: [Pressure, hover and stylus input](../how-it-works/plat/pressure-hover-stylus-input.md)

## Context

The research note (#13080, for #12539) mapped what each platform can inject beyond a finger touch.
Its follow-ups specified the design when picked up; the note fixed only the direction.

## Options

Not recorded.

## Decision

- **Pointer options on the coordinate tools.** Stylus input is an optional option on `tapAt`,
  `swipeAt` and `dragPath`, not on the element tools (`tapOn`, `swipeOn`): a stylus has no
  accessibility-element meaning.
- **Fail loudly instead of downgrading.** A device or path that cannot honour a requested pointer
  returns an actionable error and never falls back to a finger touch. A silent downgrade is the
  failure reported for Appium pressure actions, and it makes a stylus-only UI test pass for the
  wrong reason.
- **Hover is its own tool.** `hoverAt` has different semantics from a gesture (no contact, no
  scroll or fling); replay requires a route that explicitly supports hover.
- **Stage by what is proven.** `adb shell input` supports a stylus tap or straight swipe only at
  pressure `1.0`; pressure curves and hover use instrumentation or root-only `uinput`, subject to
  each route's capability checks.
- **Recording follows the tools.** A stylus step is never silently exported or replayed as a
  finger step.

## Consequences

Follow-up issues:

- #13081: stylus tool type at fixed pressure on `tapAt` and a straight `swipeAt` through
  `adb shell input`, with capability-gated errors.
- #13082: Android emulator and device experiments (pressure curve, tilt, hover, eraser and barrel
  buttons, `UiAutomation.injectInputEvent`, `uinput`, minimum API level).
- #13083: iOS simulator and device experiments (pressure, hover through public `hover()` first,
  private selectors as fallback).
- #13084: recorder capture of tool type, pressure, hover and the pen's event node, and export of
  the pointer.

Verification plan at the time:

1. Android: a physical pen device's `dumpsys input` axes, emulator-console `event send`, how a
   panel key or role maps onto `-d DISPLAY_ID`, and whether two shell invocations hold a
   double-tap interval.
2. iOS simulator: the #13083 probe (Xcode 26.6, iPad Pro 13-inch (M5), iOS 26.5, base
   `f8d061423c9`) established pressure and Pencil injection as a no-go. Mouse pointer hover
   produced `UIHoverGestureRecognizer` begin/end; Pencil hover was not observed.
3. Physical iOS device: repeat the probe if a device is available; otherwise record Pencil as out
   of scope.

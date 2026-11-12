# visionOS XCUITest runner scope

- Kind: decision
- Date: 2026-11-04
- Source: moved from `how-it-works/plat/visionos/xcuitest-capabilities.md`; #16852, #16851, #16883
- Shaped: [visionOS XCUITest capability boundary](../how-it-works/plat/visionos/xcuitest-capabilities.md)

## Context

A probe on Xcode 26.6 with the visionOS 26.5 runtime (`xrOS-26-5`) and device type
`Apple-Vision-Pro-4K` recorded what an XCUITest runner can observe and act on in a window app, to
decide the visionOS runner in #16852 (part of #16851). One test took about 38 s including app
launch.

## Options

Not recorded.

## Decision

**GO** for #16852 on the window-app scope: hierarchy with focus, element taps in the window and in
ornaments, text input, and screenshots from `simctl`. The `observe`, `tapOn` and `sendKeys`
commands are limited to these.

## Consequences

- Immersive-space content, volume windows, window move/resize, and gaze/pinch each need their
  own probe before a command depends on them.
- Screenshots must come from `xcrun simctl io <udid> screenshot`, because `XCUIScreen` returns a
  1×1 image on this runtime.

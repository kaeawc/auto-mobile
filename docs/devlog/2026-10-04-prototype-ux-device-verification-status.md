# Prototype device verification status

- Kind: concept
- Date: 2026-10-04
- Source: moved from `how-it-works/plat/android/prototype-ux.md`; #9535, #9891, #10262, #12064,
  #12200, #12266, #12395, #12797, #14126, #14182, #14207, #14208, #14209, #14210, #14232, #14233,
  #14671, #15053, #15113, #15128, #15129, #15247, #15256, #15515, #15562, #15575, #15577, #15617,
  #15732
- Shaped: [Agent-authored prototype specification](../how-it-works/plat/android/prototype-ux.md)

## Status when recorded

Host tests and JVM/Robolectric tests cover these features on fakes; the device checks below were
still owed. The section headings of these features carried "not device-verified".

- **Not device-verified features:** flow and grid, carousel and pager indicator, pull-to-refresh,
  chat lists, swipe actions, loading and empty states, effects, motion v2, transition choreography,
  charts and lazy lists.
- **Frosted backdrop:** the system layer blurring behind the window was not verified on a device.
- **Android Automotive:** the floored top inset and whether the overlay stays visible under driving
  restrictions; checking them needs a userdebug or eng AAOS image, since user builds refuse
  driving-state emulation.
- **Custom shaders (`needs-device-verify`):** real API 33+ compilation and rendering, procedural
  sources with an unused content input, and isolation of each node's sampled content and uniforms.
  Also shader output clipped to node bounds, lifecycle/background and capture-hide sampling gaps,
  frame-budget fallback under sustained and spaced load, and status/inspect reporting after a real
  rendering failure. JVM tests use fake compilers and frame clocks and give no GPU/rendering proof.
- **Haptics and sound (`needs-device-verify`):** an Android emulator tap appearing in `feedbackLog`
  and in `dumpsys vibrator_manager`, an iOS Simulator `feedbackLog` entry, and the feel on a
  physical device.
- **Lifecycle and safety:** 3-button navigation with `layer: "system"`, and a prototype shown with
  no application window in front (which Home does not hide). Device checks must cover keyguard
  timing, daemon death, pager page 3 across rotation, fold/display removal, and API 30/34/36
  keyboard/cutout geometry.
- **Bottom sheet and the keyboard:** the lift is unit-tested with fake bounds; the API 30/34/36
  device check was open.
- **Chat lists:** whether a fullscreen overlay receives IME insets (like the bottom-sheet lift,
  #10262); on iOS (#14671) the simulator acceptance of the pill, jump-to-end and keyboard behaviour.
- **Gesture actions:** whether `observe` reports the TalkBack custom actions; a device capture was
  owed before the guide promises it.
- **Effects:** goldens on API 30, 33 and 36 (`effects_all_types`, pending in
  `PrototypeSpecContentScreenshotTest`) and a real-GPU look at the AGSL effects. Robolectric covers
  decoding, API planning, the clock and budget on fakes, and bounds stability.
- **Rich text and linkify:** advertise the capability only after renderer support. Verify mixed span
  styles, resolved concatenated observe text, per-span actions without URL navigation, Android
  semanticLinks and both selectors across windows, and iOS tapAt-only links plus platformNotes. Host
  tests do not verify device rendering.
- **Lazy lists:** prepend, anchoring and per-stack-entry list scroll restore were not verified
  before the acceptance run; benchmark qualification was unverified. A 2000-row feed validated on
  the host in tens of milliseconds (`benchmark/prototype-feed-limits.ts`).
- **Strings and semantics:** device acceptance had not been run.
- **Accessibility audit on iOS:** the XCUITest `accessibilityAudit` could not target an injected
  prototype app, and the RTL change did not take effect on a simulator, so neither was verified.
- **Glass on iOS:** verification pins accessibility settings and checks structure and bounds, not
  glass pixels. Group merging, morphs, unions, image extension and accessibility appearance still
  required iOS 26 simulator verification.
- **Saved prototype pinning:** `autoConfirm` (#12266) was device-verification work because launcher
  dialogs differ.

## Test budget

The repository's 100 ms per-test unit budget is measured only from bun's JUnit reporter
(`scripts/test-ts.sh`, `scripts/validate-bun-test-timings.sh`). It does not cover Gradle or
Robolectric tests, so the Compose and host tests for window and modal motion are not held to it.

## Page process

The spec page was registered under How it Works in `mkdocs.yml` and linked from the design index.

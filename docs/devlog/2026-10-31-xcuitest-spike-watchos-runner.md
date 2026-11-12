# watchOS XCUITest runner spike

- Kind: decision
- Date: 2026-10-31
- Source: moved from `how-it-works/plat/watchos/xcuitest-spike.md`; #16062
- Shaped: [watchOS XCUITest spike](../how-it-works/plat/watchos/xcuitest-spike.md)

## Context

The spike tested the XCUITest runner approach on the watchOS simulator with Xcode 26.6,
watchOS 26.5 and an unpaired Apple Watch Series 11 (46 mm) simulator. The probe app was a SwiftUI
app with a counter button, a Crown value and rows in a scroll view.

## Options

Not recorded.

## Decision

**GO** for CtrlProxy-dependent children on hierarchy, tap and screenshot. Crown rotation was
demonstrated, with no further device questions for the spike.

## Consequences

- Scrolling a real `ScrollView` by Crown remained untested, as an implementation follow-up.
- The `os(iOS)`-gated input paths need watchOS implementations, and device acceptance after merge
  remained required.
- Physical watches and changes to the iOS CtrlProxy test target were out of scope.

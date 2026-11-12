# tvOS XCUITest runner spike

- Kind: decision
- Date: 2026-10-31
- Source: moved from `how-it-works/plat/tvos/xcuitest-spike.md`; #16062
- Shaped: [tvOS XCUITest spike](../how-it-works/plat/tvos/xcuitest-spike.md)

## Context

The spike tested whether the XCUITest runner approach works on the tvOS simulator, using
Xcode 26.6, tvOS 26.5 and an Apple TV 4K (3rd generation) simulator. The probe app was a SwiftUI
app with a 3×3 button grid and a text field.

## Options

Not recorded.

## Decision

**GO** for the runner-dependent implementation: hierarchy, focus observation, remote input, text,
sockets and screenshots were demonstrated. No simulator device-side questions remained. Physical
Apple TV was out of scope; tvOS 27 and Duo-style runtimes were untried.

## Consequences

Focus targeting is built from directional moves with a re-read after every press, because direct
focus targeting is unavailable and the focus engine remembers the last item per column.

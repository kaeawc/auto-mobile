# iOS prototype agent decisions

- Kind: decision
- Date: 2026-10-09
- Source: moved from `how-it-works/plat/ios/prototype-agent.md`; #10563, #11015, #11042, #11054,
  #11382, #15244, #15493, #15128, #15130
- Shaped: [iOS simulator prototype agent](../how-it-works/plat/ios/prototype-agent.md)

## Context

The iOS agent renders the shared prototype spec in a SwiftUI window injected into the app's process.
Several behaviors had no direct Android equivalent and were recorded as open decisions.

## Options

Not recorded.

## Decision

- **2026-10-09 (#11015).** All open decisions were settled: `inspect` maps to `get_prototype_status`;
  a bottom sheet lifts above the keyboard from keyboard-frame notifications; `window.layer: "app"` is
  ignored silently so one spec runs on both platforms.
- **Keyboard lift (#11042).** The lift is the only thing that moves for the keyboard. On an iOS 26.5
  simulator `ignoresSafeArea(.keyboard)` alone still moved a 300 pt sheet 527 pt for a 334 pt lift, so
  both hosting controllers also set `safeAreaRegions` to none.
- **Scrims, 2026-10-10 (#11382).** `window.placement.scrim` and bottomSheet `scrim` resolve through
  `PrototypePalette.scrim`.
- **Effects on platform views (#15130).** SwiftUI draws a placeholder for a platform-backed view inside
  a `layerEffect` or `distortionEffect`. The shader-sampled effects are omitted on a node that is or
  holds such a view, not on the whole spec, and reported in `degradedEffects`.
- **2026-10-26 (#15244, full list in `prototype-ux.md`).** `theme.design` defaults to `platform` (native
  SwiftUI controls where covered; segmented `Picker`, `TabView` and `Menu` keep the custom drawing
  because they lose per-item identifiers). An `android: {...}` namespace block is ignored with a
  `platformNotes` entry. System Reduce Motion and `prefersCrossFadeTransitions` map to the reduced
  motion profile (crossfades), superseding earlier "instant" wording. iOS reports only the horizontal
  size class.

## Consequences

One spec runs on both platforms with differences reported in `platformNotes`.

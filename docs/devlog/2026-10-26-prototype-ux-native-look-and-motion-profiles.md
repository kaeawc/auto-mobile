# Prototype native look and motion profiles

- Kind: decision
- Date: 2026-10-26
- Source: moved from `how-it-works/plat/android/prototype-ux.md`; #15244, #15126, #15261, #15462,
  #15493
- Shaped: [Agent-authored prototype specification](../how-it-works/plat/android/prototype-ux.md)

## Context

#15244 covered the native-look and motion-profile work for prototypes on iOS and Android.

## Options

Not recorded.

## Decision

1. **Default look.** `theme.design` defaults to `platform`. iOS prototypes look native by default
   where native coverage exists; on Android `platform` is still Material. `material` stays available
   to force the Material drawing on both platforms.
2. **Other-platform namespaces.** A renderer ignores the other platform's namespace block (`ios` on
   Android, `android` on iOS) and adds a `platformNotes` entry instead of refusing the spec, so one
   spec runs on both. This matches iOS ignoring `window.layer: "app"`.
3. **iOS Reduce Motion** maps to the _reduced_ profile (crossfades), not to _off_.
   `UIAccessibility.prefersCrossFadeTransitions` maps to _reduced_ as well.
4. **Native controls without per-item identifiers** (segmented `Picker`, `TabView`, `Menu`) keep
   the custom-drawn fallback. Each control is revisited after #15462.
5. **`surface: "glass"` on Android** waits for real backdrop blur (API 31+ `RenderEffect`, after the
   #15126 spike). Below API 31 glass is refused.
6. **Width classes** are native per platform: Android reports the Material window size classes
   (compact, medium, expanded), iOS only its horizontal size class (compact, regular). Specs branch
   per platform.
7. **Xcode 27.** An advisory (non-required) Xcode 27 iOS build runs on the self-hosted Macs. The
   required jobs switch after a green week. #15261 proceeds behind `#available`.

When the default changed, the four native iOS entries already used SwiftUI controls, so changing the
default changed no drawing, and there were no iOS prototype screenshot baselines to re-record.

## Consequences

The design coverage table, the motion profile table, the platform namespace rules and the
`/platform/device/widthClass` values in the shaped page follow these decisions.

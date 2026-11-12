# Golden replay of the nearest-match tie-break

- Kind: concept
- Date: 2026-10-08
- Source: moved from `how-it-works/plat/ios/ctrlproxy-rewrite/golden-replay.md`; #5837, #8662,
  #10857
- Shaped: [Golden capture and replay for the iOS CtrlProxy](../how-it-works/plat/ios/ctrlproxy-rewrite/golden-replay.md)

## Finding

The `HierarchyMerger` nearest-match tie-break (#8662) was checked against seven real Playground
hierarchy pairs captured from an iPhone 17 on iOS 26.5; across the corpus it alters no merged output
(#5837).

The corpus has one query with SDK candidates at two or more distinct bounds: the Scroll Performance
navigation title (`UILabel` at `[124, 73, 277, 94]`). Its candidates are three wrappers at
`[125, 74, 278, 95]` and one `UILabel` at `[125, 74, 277, 95]`. The exact-class pass sees only the
`UILabel`, so both orders pick it. In all 50 tolerance-only queries the nearest SDK candidate is
exactly 1 pt away, consistent with the same frame rounded differently. The change is a no-op on real
Playground hierarchies.

## Capture notes

During the capture, no `/sdk-events` arrived after an in-app tap, so pairs recorded right after a tap
paired the new XCUITest screen with the previous screen's SDK tree. The capture script's `--fresh`
mode was used for every committed pair; each has an SDK timestamp later than the screen change.

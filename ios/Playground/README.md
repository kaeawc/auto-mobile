# iOS Playground

## Tap At Targets

`TapAtTargetsDemo` is a screenshot-only fixture for checking `tapAt` coordinate accuracy. It draws 11 colored targets in a fixed, non-scrolling canvas: squares of 120, 88, 44, 32, 24, 16, 10, and 6 pt; a 64×8 pt horizontal bar; an 8×64 pt vertical bar; and a 36 pt circle. Targets are distributed near the upper and lower corners, top and side edges, and center. Their point dimensions stay fixed while positions follow the canvas size.

The target graphics and all labels, including annotations beside the targets 24 pt and smaller, are drawn by one SwiftUI `Canvas`. Its container uses `.accessibilityElement(children: .ignore)` and `.accessibilityLabel("Tap target canvas")`, so individual target text and bounds are absent from the accessibility tree. The result panel remains accessible: `tapat-last-result` shows the latest hit or miss, point, and nearest-center distance; `tapat-summary` lists targets not yet hit; `tapat-reset` clears the run; and `tapat-crosshairs-toggle` optionally draws center marks.

To open it directly in Simulator, set `SIMCTL_CHILD_PLAYGROUND_INITIAL_TAB=demos` and `SIMCTL_CHILD_PLAYGROUND_DEEP_LINK=tapAtTargets` for the Playground launch. `PLAYGROUND_INITIAL_TAB` selects the Demos tab, and `PLAYGROUND_DEEP_LINK` makes that tab push `TapAtTargetsDemo` on first appearance.

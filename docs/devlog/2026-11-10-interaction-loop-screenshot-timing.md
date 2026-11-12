# Post-action screenshot timing

- Kind: decision
- Date: 2026-11-10
- Source: moved from `how-it-works/mcp/interaction-loop.md`; #17774
- Shaped: [Interaction Loop](../how-it-works/mcp/interaction-loop.md)

## Context

A requested post-action screenshot is published under the same `observationId` as the hierarchy
it should match. Deferring every screenshot to the response boundary let response-path work push
the pixels seconds past the hierarchy (a popup in the tree but not in the image).

## Options

- Defer the screenshot to the response boundary for every action.
- Re-read the hierarchy after a late screenshot.
- Capture the screenshot right after the final hierarchy read, deferring only for settle-gated
  actions that can replace their hierarchy with a later capture.

## Decision

Only a settle-gated action defers the screenshot (and captures the adopted frame); every other
action captures it right after its final hierarchy read. Re-reading the hierarchy after a late
screenshot was rejected because it would add a device read to every lagging response.

## Consequences

The observation carries `screenshotHierarchyLagMs`, and above
`SCREENSHOT_HIERARCHY_LAG_THRESHOLD_MS` (500 ms) `screenshotHierarchyMismatch: true` with a
`freshness.warning`.

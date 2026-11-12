# Fixup: HierarchyMerger geometry-key matching

`HierarchyMerger` (`Sources/CtrlProxy*/HierarchyMerger.swift`) matches each XCUITest
`UIElementInfo` to an `SdkViewNode` to enrich it. The matching is pure logic, independent of the
concurrency model.

## Indices

Each SDK node has a pre-order `NodeID`. Four sorted endpoint indices, built once per merge, provide
candidate windows.

- **Direct match** checks the smallest window and chooses the nearest bounds by L∞ distance, then
  lowest `NodeID`.
- **Enclosing match** uses one-sided windows, checks the smallest, then selects by smallest signed
  area, then `NodeID`.

Candidate windows can contain all nodes, so either query's worst case is `O(n)`.

## Tie-breaks

| Path                    | Selection                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| Exact dictionary lookup | Minimum `NodeID` (first in document pre-order)                                                  |
| Enclosing match         | Smallest signed area, then document order; overflowing areas saturate to `Int.min` or `Int.max` |
| `probeToleranceMatch`   | Nearest bounds by L∞ distance, then document order                                              |

## Overflow safety

- Unrepresentable absolute coordinate differences saturate to `Int.max` and are excluded from
  tolerance matches; tolerance windows saturate at `Int.min`/`Int.max`.
- Signed dimensions and areas saturate by sign; centers are origin + half the saturated signed
  dimension (truncated toward zero).
- Endpoints are unchanged, including inverted bounds.

`HierarchyMergerGoldenReplayTests` replays captured `(xcuitest, sdk)` pairs (see
[golden replay](golden-replay.md)).

## Background

- [HierarchyMerger range-index matching](../../../../devlog/2026-10-01-fixup-hierarchy-merger-geometry-range-index.md)

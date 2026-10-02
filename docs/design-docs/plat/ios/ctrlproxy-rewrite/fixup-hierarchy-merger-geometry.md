# Fixup: HierarchyMerger geometry-key matching

**Status:** Phase 8 geometry matching is implemented. Containment uses per-coordinate
sorted indices and signed-area ranking; nearest matching uses coordinate windows
with L∞ distance, then document order. Worst case remains O(n) per distinct query.
Golden-replay validation of real hierarchy pairs is pending a live runner.
**Scope:** pure logic in `HierarchyMerger` (`Sources/CtrlProxy*/HierarchyMerger.swift`).
Decoupled from the concurrency migration — can land as its own PR.

## Context

`HierarchyMerger` matches each XCUITest `UIElementInfo` to an `SdkViewNode` to
enrich it. The original implementation used two brute-force geometric queries:

1. **`findDirectMatch` — near-exact ±tol match.** It probed all
   `delta ∈ [-tol...tol]⁴` tuples, or 625 dictionary keys per query, against both
   the class and bounds indices. Cost grew as `tol⁴`. Historically, #3634 moved
   this from padded _insertion_ to padded _lookup_; it relocated the same brute
   force to query time.
2. **`enclosingMatch` — containment.** The old code selected the first enclosing
   node from an area-sorted list with a linear `O(n)` scan (cached per bounds).

## Implemented indices

Each SDK node has a pre-order `NodeID`. Four sorted endpoint indices provide
candidate windows; direct matching checks the smallest window and chooses nearest
bounds by L∞ distance, then `NodeID`. Enclosing matching uses one-sided windows,
checks the smallest, then selects by signed area and `NodeID`. Both indices are
built once per merge. Candidate windows can contain all nodes, so either query's
worst case remains `O(n)`.

## Parity decisions (implemented)

| Path                    | Previous behavior                                | Current behavior                                                                         |
| ----------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Exact dictionary lookup | First insertion wins (document pre-order)        | Same via minimum `NodeID`                                                                |
| Enclosing match         | Smallest signed area, then stable document order | Same selection; overflowing areas saturate to `Int.min` or `Int.max`                     |
| `probeToleranceMatch`   | First hit in ascending delta-loop order          | Nearest bounds by L∞ distance, then document order; this is the reviewed behavior change |

## Validation and remaining work

Capture real `(xcuitest, sdk)` hierarchy pairs from a live runner and compare
merged output to quantify which frames are affected by the nearest-match tie-break
change. Bounds arithmetic is now overflow-safe: unrepresentable absolute coordinate
differences saturate to `Int.max` and are excluded from tolerance matches; tolerance
windows saturate at `Int.min`/`Int.max`. Signed dimensions and areas saturate by sign,
and centers retain origin + half the saturated signed dimension (truncated toward
zero). Endpoints remain unchanged, including inverted bounds. Results for all
previously non-overflowing inputs are preserved.

Done: containment indexing with signed-area/document-order selection, and ±tol
coordinate-window matching with nearest-distance/document-order selection.
Remaining: run the golden replay on a live runner and document the observed
nearest-match differences.

# HierarchyMerger range-index matching

- Kind: decision
- Date: 2026-10-01
- Source: moved from `how-it-works/plat/ios/ctrlproxy-rewrite/fixup-hierarchy-merger-geometry.md`;
  #3634, #5837, #8662, #8685, #8719
- Shaped: [Fixup: HierarchyMerger geometry-key matching](../how-it-works/plat/ios/ctrlproxy-rewrite/fixup-hierarchy-merger-geometry.md)

## Context

`HierarchyMerger` originally used two brute-force geometric queries:

1. `findDirectMatch`, a near-exact ±tol match, probed every `delta ∈ [-tol...tol]⁴` tuple (625
   dictionary keys per query). It probed both the class and bounds indices, so cost grew as `tol⁴`.
   #3634 had moved this from padded insertion to padded lookup, relocating the same brute force to
   query time.
2. `enclosingMatch` picked the first enclosing node from an area-sorted list with a linear `O(n)`
   scan (cached per bounds).

The fix was scoped as pure logic, decoupled from the Swift 6 concurrency migration.

## Options

Not recorded.

## Decision

Replace both with sorted endpoint range indices keyed by `NodeID` in pre-order. Exact lookup (first
insertion wins) and enclosing match (smallest signed area, then document order) keep their previous
selection. The `probeToleranceMatch` query changed from first hit in ascending delta-loop order to nearest
bounds by L∞ distance, then document order; this was the reviewed, intentional behavior change.
Bounds arithmetic was made overflow-safe while preserving results for all previously
non-overflowing inputs.

## Consequences

Golden replay of seven real Playground hierarchy pairs captured from a live simulator runner found
no merged-output difference from the old loop-order tie-break. None of the 50 tolerance-only queries
in the corpus changed its match (#5837).

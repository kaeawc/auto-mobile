# Fixup: HierarchyMerger geometry-key matching

**Status:** designed, deferred to Phase 8 (post-concurrency fixups).
**Scope:** pure logic in `HierarchyMerger` (`Sources/CtrlProxy*/HierarchyMerger.swift`).
Decoupled from the concurrency migration — can land as its own PR.

## Context

`HierarchyMerger` matches each XCUITest `UIElementInfo` to an `SdkViewNode` to
enrich it. Two distinct geometric queries hide inside it, and both are implemented
with brute force:

1. **`findDirectMatch` — near-exact ±tol match.** Find an SDK node whose
   `(className, left, top, right, bottom)` equals the query within `±boundsTolerance`
   (=2) on each coordinate. Imprecision is handled by `probeToleranceMatch`, a
   4-nested loop over `delta ∈ [-tol...tol]⁴` = `(2·2+1)⁴ = 625` dictionary probes
   **per query**, run against both the className index and the bounds-only index
   (~1250 probes/query). Cost grows as `tol⁴`. (Historical note: #3634 moved this
   from padded _insertion_ — inserting every node at all 625 shifted keys — to
   padded _lookup_; it's the same brute force relocated to query time.)

2. **`enclosingMatch` — containment.** Smallest-area SDK node that _encloses_ the
   query box (±tol margin). Implemented as a linear `O(n)` scan over an
   area-sorted list, first-container-wins (cached per bounds).

## Proposed redesign

Index each SDK node **once** with its exact geometry; answer queries as
**set intersections** over per-axis indices. Assign each SDK node a stable
`NodeID` = its pre-order document index, so candidate sets are `Set<Int>` (cheap to
intersect) and the document-order tie-break is recoverable as `min(id)`.

- **Containment (2) → interval trees.** An X-interval tree over SDK `[left, right]`
  ranges + a Y-interval tree over `[top, bottom]`. Query = "SDK intervals containing
  the query's X-range" ∩ "containing its Y-range" → candidate enclosers → pick
  smallest area. Replaces the `O(n)` scan with `O(log n + k)`. Give the trees a
  set-flavored API: `func ids(containing: ClosedRange<Int>) -> Set<NodeID>`.

- **±tol match (1) → per-coordinate range indices.** Interval _intersection_ is the
  wrong semantic here (we want endpoint-proximity, not overlap). Keep 4 sorted
  arrays (one per coordinate); binary-search the `[q-tol, q+tol]` window on each →
  4 candidate ID sets → intersect. **4 binary searches instead of 625 probes, and
  independent of `tol`** (works for any tolerance). API:
  `func ids(inRange: ClosedRange<Int>) -> Set<NodeID>` per coordinate.

## The parity constraint (why this is deferred, not done)

The rewrite's contract is byte-identical output vs the oracle. The current matchers
carry specific tie-breaks:

| Path                  | Current tie-break                                                | Reproducible under set-intersection?              |
| --------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| exact dict lookup     | first-inserted wins (`if lookup[key]==nil`) = document pre-order | ✅ `min(NodeID)`                                  |
| `enclosingMatch`      | smallest area, then document order (stable sort)                 | ✅ well-defined; reproduce exactly                |
| `probeToleranceMatch` | **first hit in delta-loop order** (`dl,dt,dr,db` ascending)      | ❌ loop-order artifact, not a geometric criterion |

- **Containment rewrite is parity-preserving.** Smallest-area + document-order is a
  clean criterion; the interval-tree version reproduces it exactly and the
  merge-parity test stays green. Safe to land opportunistically.

- **±tol rewrite is an intentional behavior change.** The current code returns the
  _first delta-tuple that hits_, which is neither "closest" nor "smallest" — a node
  at delta `(-2,0,0,0)` beats a closer one at `(0,0,0,+1)` purely by loop order.
  A set-intersection returns a _set_; matching the old artifact byte-for-byte isn't
  meaningful. **Decision (owner, this session): upgrade the tie-break to the
  more-correct "nearest bounds by L∞ distance, then document order," accepting a
  scoped, reviewed behavior change** on this path. Parity-first still holds: we do
  NOT make this change until the critical path is complete and we can validate it in
  isolation.

## Validation plan

Do not rely on the hand-written merge fixture alone. Capture a **golden-replay
corpus**: record a batch of real `(xcuitest, sdk)` hierarchy pairs once from the
live runner, snapshot current merge output, then refactor and diff. This quantifies
whether the ±tol tie-break change touches _any_ real frame, and gives the
containment rewrite a far stronger regression net than a synthetic fixture.

## Sequencing

Land after the concurrency phases. Order within Phase 8:

1. Containment → interval trees (parity-preserving; verify with existing gate + corpus).
2. ±tol → coordinate range-intersection with the new tie-break (regenerate the
   affected golden; validate against the replay corpus; document the diff).

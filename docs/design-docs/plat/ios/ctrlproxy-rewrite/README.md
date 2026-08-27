# CtrlProxy Swift-6 rewrite — planning notes

Working notes for the `ios/control-proxy` Swift-6 concurrency rewrite
(`CtrlProxyRewrite` target). These are **temporary planning docs**: they capture
design decisions and deferred improvements uncovered while porting, and should be
pruned as the work they describe lands.

**To resume the work (incl. from a fresh session): start with [STATUS.md](STATUS.md)** —
the authoritative "where we are / how to continue" doc (current phase, commits, build/test
gate, parity technique, archetype decisions, race ledger, and the next phase's plan). A
new session can be pointed at it with minimal guidance. (An abbreviated running status is
also mirrored in the assistant's project memory `ctrlproxy-swift6-rewrite`.)

## Approach (recap)

Parallel reimplementation, not in-place migration. The shipped `CtrlProxy` target
stays as a **behavioral oracle** (pinned to Swift 5 language mode) while
`CtrlProxyRewrite` is brought up under strict Swift 6 concurrency and verified
against it by differential parity tests keyed off the frozen wire contract. See the
memory note for the archetype map and the race ledger.

## Amended phase plan

Critical path (the rewrite's actual goal — concurrency correctness + parity):

0. Scaffold + wire-decode parity gate ✅
1. Pure/stateless core (models, StructuralHasher, HierarchyMerger, geometry
   helpers, framing statics + wire-error mapping) ✅
2. Networking core (queue-confinement: WebSocketServer / connection / byte channel) ✅
3. Off-main SDK layer (SdkHierarchyCache **lock-confined** + transactional `reconcile`;
   SDK/DB clients async; OSLogReader) ✅ — the cache is a lock, not the actor first
   proposed here; see [STATUS.md](STATUS.md) §6 for the (approved) rationale.
4. `@MainActor` UI domain (ElementLocator, GesturePerformer, HierarchyDebouncer,
   DisplayLinkFPSMonitor, VoiceOver) ✅
5. PerfProvider (TaskLocal call-tree + confined pool) ⟵ **NEXT**
6. CommandHandler (Sendable POD router) + CtrlProxy coordinator
7. Cutover (point the runner/app at the rewrite; retire the reference)

**8. Post-concurrency fixups (NEW).** Pure, off-critical-path improvements that we
deliberately defer so the concurrency migration lands *parity-first*. Each is
captured as a note below and only acted on once the critical path is done (or, if a
note is parity-preserving and self-contained, opportunistically — but never at the
cost of parity discipline).

## Deferred-fixup index

| Note | Area | Parity risk | Status |
|---|---|---|---|
| [hierarchy-merger-geometry](fixup-hierarchy-merger-geometry.md) | `HierarchyMerger` bounds matching | Mixed (containment: none; ±tol: intentional behavior change, approved) | Designed, deferred to Phase 8 |
| dead API: `ElementLocator.getCachedElement` | ElementLocator | None (drop/internalize) | ✅ Resolved — dropped when porting `ElementLocator` (Phase 4F); not carried into the rewrite |
| `Timer` protocol shadows `Foundation.Timer` | PerfProvider/scheduling | None (rename) | Noted; resolve when porting the timer seam (Phase 5) |
| `GesturePerformer` keyboard-focus / keyboard-visibility polling | GesturePerformer | None (parity-preserving keep) | Noted (uncovered porting `GesturePerformer`, Phase 4G); `tapAndAwaitKeyboardFocus` / `waitForKeyboardVisibility` spin `RunLoop.current.run(until:)` on `Date()`-based deadlines, blocking the main actor for up to their timeout. Ported verbatim; replace with a non-blocking wait in Phase 8 |

Append new entries here as they're uncovered.

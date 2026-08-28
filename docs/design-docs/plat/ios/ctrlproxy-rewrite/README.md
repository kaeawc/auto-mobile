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
5. PerfProvider (TaskLocal call-tree + confined pool) ✅
6. CommandHandler (Sendable POD router, async) + async serial dispatch + CtrlProxy coordinator ✅
7. Cutover — **in progress**:
   - 7A ✅ wire rewrite into XcodeGen (additive `CtrlProxyRewriteUITests` target) + first green
     iOS-simulator compile (host-hidden `ElementLocator` init fixed).
   - 7B ✅ iOS strict-concurrency warning cleanup (the ~149 non-fatal iOS-only warnings → 0;
     `DeviceRotation`/`VoiceOverToggling` isolation; runtime-validated — `testServiceStarts` runs
     green on an iOS 27 simulator).
   - 7C ✅ (middle route) production runner switched to the rewrite — the `CtrlProxyUITests` target
     now compiles `Sources/CtrlProxyRewrite` (name/app/identifier kept → zero TS/script churn);
     reference kept as the SwiftPM parity oracle.
   - 7D ✅ on-device validation: `testServiceStarts` green + the full observe→gesture→hierarchy loop
     (`HierarchyIntegrationTests`) green on the **iOS 26.5** sim (tap/typeText/secure-field masking,
     0 failures). Skip-guarded so it skips on the 27.0-**beta** runtime (host-app launch flake, not the
     rewrite).
   - 7E retire the reference target (ends the differential-parity harness) — gate cleared by 7D,
     **deferred per the middle-route preference**; on request.

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
| `Timer` protocol shadows `Foundation.Timer` | PerfProvider/scheduling | None (rename) | ✅ Resolved — renamed to `ProxyTimer` when porting the timer seam (Phase 4A) |
| `GesturePerformer` keyboard-focus / keyboard-visibility polling | GesturePerformer | None (parity-preserving keep) | Noted (uncovered porting `GesturePerformer`, Phase 4G); `tapAndAwaitKeyboardFocus` / `waitForKeyboardVisibility` spin `RunLoop.current.run(until:)` on `Date()`-based deadlines, blocking the main actor for up to their timeout. Ported verbatim; replace with a non-blocking wait in Phase 8 |
| PerfProvider is an over-elaborate interval accumulator | PerfProvider | None (external timing data stays equivalent) | Noted (porting `PerfProvider`, Phase 5). The whole `MutablePerfEntry` tree + `@TaskLocal` scope + pooled flush is an elaborate way to compute the handful of intervals actually reported. Ported faithfully to keep the emitted `perfTiming` byte-identical; replace with `os_signpost` / direct interval math in Phase 8 (external API/data equivalent, per Paul: "direct rewrite then refactor"). The reference singleton was already dropped in the port (injected `any PerfTracking`; see [STATUS.md](STATUS.md) §6) — do not restore it for parity |

Append new entries here as they're uncovered.

## Beyond ctrl-proxy — native-Swift landscape & follow-ups

Captured while answering "where does ctrl-proxy fit, and what else needs a Swift-6 pass?"
(evidence: a subsystem survey of `ios/*` + the TS integration). Not full roadmaps — pointers.

**ctrl-proxy structure — two simplifications evaluated and rejected (don't re-litigate):**
- The server runs *inside the XCUITest runner* (`CtrlProxyUITests-Runner.app` → `testRunService`),
  not in `CtrlProxyApp` (that app is only the required UI-test *host*; blank VC). Cross-app
  hierarchy reads + gesture injection come from `XCUIApplication`/`XCUIElement`, a privilege
  `testmanagerd` grants **only** to a UI-test process — no entitlement grants it, so it can never
  be a packaged/App-Store app. `control-proxy.ipa` is just a zip of `Build/Products/`.
- **macOS CLI target** (in the SPM package): not useful — on macOS the whole `ElementLocator`/
  `GesturePerformer` capability compiles out (`#if os(iOS)`); a CLI server would drive nothing, and
  XCUITest isn't available to a plain executable anyway. The `#else` "non-iOS mode" path is only a
  fast host compile/parity gate.
- **Drop `CtrlProxy.xcodeproj` for pure SPM**: not feasible — SPM can't emit the `bundle.ui-testing`
  product / `XCTRunner.app`, an iOS app host, the `.xctestrun`, or the signing/install orchestration.
  The SPM (fast host logic + parity + the `.v6` `CtrlProxyRewrite`) ⇄ xcodegen (the only thing that
  builds the shipped runner) split **is** the minimal form; `project.yml` is already the declarative
  source of truth.

**Other native-Swift components needing their own Swift-6 pass (ranked, separate from this rewrite):**
- **`ios/auto-mobile-sdk`** (in-app instrumentation SDK; ctrl-proxy links it for wire models) — **largest
  need.** It is architecturally the *pre-rewrite ctrl-proxy state*: ~44 `@unchecked Sendable` + NSLock,
  ~20 mutable singletons, real flagged races (signal-handler globals; the `AutoMobileURLProtocol`
  Sendable error already in STATUS §5). **CI builds it macOS-only**, so its iOS UIKit `@MainActor`
  surface is unchecked → true error count exceeds what a host build shows. Hard blocker: **iOS 15 floor
  rules out both `Mutex` and `OSAllocatedUnfairLock`** — decide raise-floor vs. `os_unfair_lock`/actor
  first. Likely warrants the same parallel-target + parity-oracle playbook. First step: an *iOS-platform*
  strict build to measure the real surface.
- **`ios/XCTestRunner`** (standalone MCP-client XCTest wrapper — the iOS analog of the Android JUnit
  runner; NOT an XCUITest harness, no `XCUIApplication`; no code coupling to ctrl-proxy) — **moderate,
  in-place.** Already tools-6.0/`.v5`. Work concentrates in 2 MCP-client classes (fields mutated from
  `@Sendable` closures → queue-confine or async-seam POD) + ~4 singleton annotations. Surfaces a real
  bug: `TestTimingCache.clear()` mutates state without `loadLock`. No parity machinery needed.
- **`ios/screen-capture`** (independent macOS CLI video helper; frozen stdout wire protocol) —
  **moderate, annotate-and-isolate** (future-proofing; no current race). Already coded toward Swift 6
  (`withLock`, 3 `@unchecked Sendable`). Per-target `.v6` + `@Sendable` on ~17 closures + make 5
  capture/writer classes Sendable; expect ScreenCaptureKit/AVFoundation `@MainActor`-drift churn.
  Verification is easy (macOS target → every body compiles on the host). Keep `runBlocking` as-is.
- **`ios/Playground`** (internal SwiftUI SDK demo/test-host app, not shipped) — **defer**; no
  concurrency surface of its own. Should follow `auto-mobile-sdk`, not lead.

# CtrlProxy Swift 6 parallel rewrite

- Kind: decision
- Date: 2026-09-09
- Source: moved from `how-it-works/plat/ios/ctrlproxy-rewrite/README.md`; #5834, #5839, #8666,
  #8900
- Shaped: [CtrlProxy Swift 6 rewrite](../how-it-works/plat/ios/ctrlproxy-rewrite/README.md)

## Context

`ios/control-proxy` needed a Swift 6 strict-concurrency migration. The product and target were
called `CtrlProxyRewrite` (tests `CtrlProxyRewriteTests`) during the work; both were later renamed to
`CtrlProxy` / `CtrlProxyTests`.

## Options

- Parallel reimplementation with the old code as an oracle.
- In-place migration.

Two structural simplifications were also evaluated and rejected (do not re-litigate):

- A macOS CLI target: useless, because the `ElementLocator`/`GesturePerformer` capability compiles out
  on macOS and XCUITest is unavailable to a plain executable.
- Pure SPM instead of `CtrlProxy.xcodeproj`: not feasible, since SPM cannot emit the UI-testing
  bundle, `XCTRunner.app`, an iOS app host, the `.xctestrun`, or the signing/install orchestration.

## Decision

Parallel reimplementation, not in-place migration. The old `CtrlProxy` stayed as a behavioral oracle
(Swift 5 mode) while the team built `CtrlProxyRewrite` under strict Swift 6 concurrency and verified it
by differential parity against the frozen wire contract. Phases 0-7 (scaffold, pure core, networking,
off-main SDK layer, `@MainActor` UI, PerfProvider, CommandHandler/coordinator, cutover) completed and
the oracle was retired.

Post-concurrency (Phase 8) improvements were deferred so the migration landed parity-first, tracked
in a deferred-fixup index:

| Item                                                            | Area                              | Parity risk                                                            | Outcome                                                                                                                                              |
| --------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| HierarchyMerger geometry matching                               | `HierarchyMerger` bounds matching | Mixed (containment: none; ±tol: intentional, approved behavior change) | Implemented; golden replay shows no output change on real pairs                                                                                      |
| dead API `ElementLocator.getCachedElement`                      | ElementLocator                    | None                                                                   | Dropped in the port                                                                                                                                  |
| `Timer` protocol shadows `Foundation.Timer`                     | PerfProvider/scheduling           | None                                                                   | Renamed `ProxyTimer`                                                                                                                                 |
| `GesturePerformer` keyboard-focus / keyboard-visibility polling | GesturePerformer                  | Deadline-edge probes detect conditions met during an overrunning sleep | All four waits await `KeyboardWait` with an injected monotonic `Clock` (#8666)                                                                       |
| PerfProvider over-elaborate interval accumulator                | PerfProvider                      | None                                                                   | Flat interval records with direct duration math build the existing `PerfTiming` shape on demand; injected `any PerfTracking` and pooled flush remain |

## Consequences

Other native-Swift components were ranked for their own Swift 6 pass, as separate work:

- `ios/auto-mobile-sdk` (ctrl-proxy links it for wire models): largest need, architecturally the
  pre-rewrite ctrl-proxy. CI built it macOS-only, so its iOS UIKit `@MainActor` surface was
  unchecked. #5839 moved the SDK and highlight-core targets to Swift 6 and converted most types to
  checked `Sendable`. It left zero concurrency diagnostics on the macOS host build and a generic iOS
  Simulator `xcodebuild`. The remaining `@unchecked Sendable` set for `UserDefaultsInspector`,
  `SQLiteDatabaseDriver` and `AutoMobileWebViewBridge` is owner decision D52. The iOS 17 / macOS 15
  floor is an owner decision of 2026-10-02. `SdkHighlightOverlayManager` is internal, so whole-type
  `@MainActor` is possible; its caller is `SdkHierarchyServer`'s off-main HTTP continuation.
- `ios/XCTestRunner` (standalone MCP-client XCTest wrapper, no code coupling to ctrl-proxy): moderate,
  in place. Already tools-6.0/`.v5`. Work concentrates in 2 MCP-client classes (fields mutated from
  `@Sendable` closures) plus about 4 singleton annotations. It surfaces a real bug:
  `TestTimingCache.clear()` mutates state without `loadLock`.
- `ios/screen-capture` (macOS CLI video helper; frozen stdout protocol): moderate, future-proofing
  with no current race. Per-target `.v6`, `@Sendable` on about 17 closures, make 5 capture/writer
  classes Sendable; expect ScreenCaptureKit/AVFoundation `@MainActor` churn. Keep `runBlocking`.
- `ios/Playground` (internal SwiftUI demo/test host): defer; follows `auto-mobile-sdk`.

For stalled unlock swipes, tracked-app anchoring and its implicit idle wait remained a hypothesis;
explicit SpringBoard anchoring was left unbuilt pending device evidence (#8900).

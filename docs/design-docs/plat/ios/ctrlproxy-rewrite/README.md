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

   Physical-device VoiceOver Settings lookup now prefers a stable `VoiceOver`
   accessibility identifier, then the sourced English label. If neither is
   exposed, it opens the first Accessibility navigation cell and accepts the
   sole switch on that sub-page. An unmatched switch on the Accessibility root
   is never tapped, nor is an ambiguous sub-page with multiple switches.
   Apple Settings translations are not bundled in this repo, so there is no
   verified localized label table; a reordered first cell or a changed sub-page
   structure still needs physical-device validation.

5. PerfProvider (TaskLocal call-tree + confined pool) ✅
6. CommandHandler (Sendable POD router, async) + async serial dispatch + CtrlProxy coordinator ✅
7. Cutover — ✅ **complete** (`CtrlProxyRewrite` is the sole implementation):
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
   - 7E ✅ reference retired — KEEP wire-contract tests re-anchored reference-free (`JSONGolden`
     containment/idempotence + Framing/Geometry invariants); behavioral-domain parity tests dropped;
     `Sources/CtrlProxy`, `Tests/CtrlProxyTests`, the SwiftPM + Xcode reference targets, and the
     differential-parity harness removed. SPM 196 tests green; sim build + runner smoke green.

   Remaining after cutover: **Phase 8** fixups (below) + the deferred Phase-2 loopback/connection
   scenarios as iOS UI tests.

**8. Post-concurrency fixups (NEW).** Pure, off-critical-path improvements that we
deliberately defer so the concurrency migration lands _parity-first_. Each is
captured as a note below and only acted on once the critical path is done (or, if a
note is parity-preserving and self-contained, opportunistically — but never at the
cost of parity discipline).

## Deferred-fixup index

| Note                                                            | Area                              | Parity risk                                                            | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [hierarchy-merger-geometry](fixup-hierarchy-merger-geometry.md) | `HierarchyMerger` bounds matching | Mixed (containment: none; ±tol: intentional behavior change, approved) | Designed, deferred to Phase 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| dead API: `ElementLocator.getCachedElement`                     | ElementLocator                    | None (drop/internalize)                                                | ✅ Resolved — dropped when porting `ElementLocator` (Phase 4F); not carried into the rewrite                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Timer` protocol shadows `Foundation.Timer`                     | PerfProvider/scheduling           | None (rename)                                                          | ✅ Resolved — renamed to `ProxyTimer` when porting the timer seam (Phase 4A)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GesturePerformer` keyboard-focus / keyboard-visibility polling | GesturePerformer                  | Deadline-edge probes detect conditions met during an overrunning sleep | ✅ Resolved — all four waits (focus, visibility, close, destructive-key post-condition) await `KeyboardWait` with an injected monotonic `Clock`, yielding the main actor between probes and checking the condition after the final sleep. Close-action deadline gates and horizontal-arrow budgets use the same injected clock. The waits honour task cancellation (`CancellationError`), but WebSocketServer's serial command-chain tasks are unstructured and never cancelled, so cancellation is currently unreachable in production. |
| PerfProvider is an over-elaborate interval accumulator          | PerfProvider                      | None (external timing data stays equivalent)                           | ✅ Resolved — flat interval records with direct duration math build the existing `PerfTiming` shape on demand; injected `any PerfTracking` and pooled flush semantics remain. No reference singleton.                                                                                                                                                                                                                                                                                                                                    |

Append new entries here as they're uncovered.

## Beyond ctrl-proxy — native-Swift landscape & follow-ups

Captured while answering "where does ctrl-proxy fit, and what else needs a Swift-6 pass?"
(evidence: a subsystem survey of `ios/*` + the TS integration). Not full roadmaps — pointers.

**ctrl-proxy structure — two simplifications evaluated and rejected (don't re-litigate):**

- The server runs _inside the XCUITest runner_ (`CtrlProxyUITests-Runner.app` → `testRunService`),
  not in `AutoMobileTest` (that app is only the required UI-test _host_; blank VC). Cross-app
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
  need.** It is architecturally the _pre-rewrite ctrl-proxy state_: **11 `@unchecked Sendable`** in
  `Sources/` (down from 26 before step 3, 35 after the base step, ~44 originally) + NSLock.
  **CI builds it macOS-only**, so its iOS UIKit `@MainActor` surface is unchecked → an
  _iOS Simulator_ `SWIFT_STRICT_CONCURRENCY=complete` build now measures **158 unique diagnostics**
  (down from 163 before step 3): 150 actor isolation (unchanged; UIKit main-actor pass not started),
  4 global/static mutable state (from 5), 2 non-Sendable captures/conversions (from 6),
  2 Sendable conformance (unchanged).
  Converted so far (#5839): Storage (`DatabaseInspector`, `DefaultDatabaseDriver`,
  `DefaultUserDefaultsDriver`, `UserDefaultsStoreResolver`, per-call ISO-8601 formatter),
  `NetworkMockRuleStore` plus Sendable conformances on `NetworkFaultTransport`, `NetworkFaultAction`,
  `NetworkFaultRuleDTO`, `FaultRequest`, `FaultDecision`; `NetworkCaptureRecorder` and its three
  adapters; `AutoMobileWebViewPolicy`. Step 3 converts 15 more types to checked `Sendable`:
  `AutoMobileBiometrics`, `AutoMobileFailures`, `AutoMobileNetwork`, `AutoMobileNotifications`,
  `AutoMobileInteractionTracker`, `ViewBodyTracker`, `NavigationAdapterHub`,
  `DeepLinkNavigationAdapter`, `CustomNavigationAdapter`, `UIKitNavigationAdapter`,
  `SwiftUINavigationAdapter`, `BlockNavigationListener`, `DefaultAutoMobileAPI`,
  `DefaultAutoMobileCrashesAPI`, `DefaultAutoMobileNetworkAPI`.
  Five diagnostics fixed at source: lock-protected `AutoMobileURLProtocol.faultScheduler`
  (internal DEBUG-only `FaultScheduling` is now `Sendable`, taking a `@Sendable` closure instead of
  `DispatchWorkItem`), two `UNUserNotificationCenter` delegate completion handlers in internal
  `NotificationActionHandler`, and two private HTTP body-reader completions in `SdkHierarchyServer`
  (all four closures now `@Sendable`). Remaining unchecked (11): `AutoMobileSDK`,
  `AutoMobileNotificationObserver`, `AutoMobileOsEvents`, `ViewHierarchyTracker` (non-Sendable
  NotificationCenter observer tokens `[NSObjectProtocol]`); `AutoMobileCrashes` (non-Sendable
  injected handler closures); `AutoMobileHangs` (`Thread?` and non-Sendable injected closures);
  `NotificationActionHandler` (weak non-Sendable `UNUserNotificationCenterDelegate`);
  `SdkHierarchyServer` (injected `any NSLocking`, non-Sendable listener existentials, weak server
  reference, non-Sendable factory/logging closures); by owner decision D52, `UserDefaultsInspector`
  (non-Sendable public `UserDefaultsChangeListener` values and observer token), `SQLiteDatabaseDriver`
  (cached raw `OpaquePointer` handles), `AutoMobileWebViewBridge` (mutable `weak var WKWebView` and
  main-actor WebKit delegate requirements).
  Remaining non-actor blockers (4 global/static + 2 captures/conversions + 2 conformance):
  `AutoMobileCrashes.signalCrashFilePath` / `previousSignalHandlers` (C signal handler must stay
  lock-free and async-signal-safe); `SdkHighlightOverlayManager.shared`, timer `self` capture and
  removal-closure conversion (UIKit/Timer state, main-actor pass). `AutoMobileURLProtocol` is now
  `final` and `@unchecked Sendable` (all mutable state, instance and static, sits in
  `OSAllocatedUnfairLock`s); `final` is not a source break because the class is `public`, not
  `open`, so no other module could subclass it.
  Main-actor sizing: `ViewHierarchyWalker` is a public enum with synchronous public `walk(bundleId:)`
  / `computeHash(_:)`; whole-type `@MainActor` changes public API → nonisolated public facades over
  an isolated internal implementation. Callers: `ViewHierarchyTracker.walkNow()` / `performWalk()`
  / hash, reached from the Network.framework request queue via `SdkHierarchyServer`.
  `SdkHighlightOverlayManager` is internal → whole-type `@MainActor` is possible without a public
  change; highlight-show caller is `SdkHierarchyServer`'s off-main HTTP request continuation,
  plus main-isolated Playground tests. Timer callback and teardown need internal work.
  Next: UIKit main-actor pass over those two types and the remaining actor-diagnostic files
  (`AutoMobileOsEvents.swift`, `AutoMobileInteractionTracker.swift`, `NavigationAdapters.swift`,
  `AutoMobileFailures.swift`, `ViewHierarchyTracker.swift`); signal-handler globals and URLProtocol
  decisions; then enable `.v6`. **Done (#5839):** the SDK and highlight-core targets (sub-package
  manifests and the root `Package.swift`) now compile in the Swift 6 language mode with zero
  concurrency diagnostics on both the macOS host build and a generic iOS Simulator `xcodebuild`;
  the counts above are historical. The **iOS 17 / macOS 15 floor** is decided and applied (#5839,
  owner decision 2026-10-02): iOS 17 already shipped in #6773;
  the SDK and highlight-core sub-package manifests were aligned here. Use **`OSAllocatedUnfairLock`**
  for the concurrency pass; `Mutex` requires iOS 18.
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

## Gesture phase diagnostics

Tap-coordinate, swipe, drag, and pinch responses append a `gesturePhases` child to
an existing optional `perfTiming` tree. Its monotonic durations include `queueWait`
(receipt to execution start), `executionPreparation` (decode, handler validation,
frame-context work and main-actor scheduling), `targetResolution` (stored app
reference), `coordinateResolution`, `xcuitestGesture`, and `postGesture` where those
phases execute. XCUITest's internal app resolution and idle waits remain inside
`xcuitestGesture`; instrumentation adds no app-state queries. Child durations sum
to the gesture total, which includes queue wait and can exceed the enclosing
handler's execution-only duration. No perf tree means no added wire fields.

A deadline breach or a total strictly greater than 2,000 ms emits one
`gesture_phases command=... <phase>Ms=... totalMs=... deadlineRemainingMs=...`
warning under subsystem `dev.jasonpearson.automobile`, category `GesturePerformer`.
Unexecuted phases are omitted; deadline remaining is signed, or `none`. The
frontmost app is not queried. The daemon preserves phase children on failures,
adds them to requested iOS swipe timing, includes a received swipe failure's
summary in its error, and warns with phases when the pending request has already
been removed. It does not extend deadlines or wait for late replies.

The optional boolean `request_swipe.lockScreen` is sent only by the unlocker's
swipe. Absent/false preserves the ordinary XCUITest swipe; older runners ignore
the field. True reuses single-finger synthesized event delivery without resolving
or activating the tracked app (which can be stale on the lock screen) or waiting
for app idle. Its phase is `synthesizedGesture`. Missing synthesis symbols fall
back to the ordinary swipe; other synthesis failures remain errors.

A swipe carrying `timeoutMs` has an execution response bound of
`max(250, deadlineRemainingAtExecutionStartMs - 500)` ms. The 500 ms reserve aims
to deliver a typed `swipe_result` failure before the host transport deadline.
The watchdog uses injected `ProxyTimer.wait`, never `schedule`: `SystemTimer.schedule`
dispatches to the main queue, which a synchronous XCUITest call can block. The
unstructured handler/watchdog Tasks inherit gesture and perf TaskLocals. XCUITest
is main-thread-confined and cannot be cancelled mid-call, so the serial chain and
in-flight guard stay held until the real handler returns; `runner_busy` continues
to name the blocker. Tap/drag/pinch have no wire execution deadline. Separately,
the host `pinchOn` tool limits requested duration to an integer from 1 to 10000 ms
(default: 300 ms).

At the bound an immediate `gesture_phases ... boundHit=true phaseAtBound=...`
line records the running phase and elapsed time (including queue wait), and the
phase appears in the timeout error. When the real call returns, its final phase
line also includes `phaseAtBound=...`, even below the slow threshold. The late
response is discarded, while perf and failure-coordinator cleanup still runs.
For swipes, both bound and final log lines additionally report
`dispatch=xcuitest|synthesizedLockScreen`, `trackedApp=<cached bundle id>|none`, and
`xcuitestEntered=true|false`, derived from whether `xcuitestGesture` began.
The cached tracker is not an app-state query; XCUITest activity lines are not forwarded.
Tracked-app anchoring and its implicit idle wait remain a hypothesis for stalled
unlock swipes; explicit SpringBoard anchoring remains unbuilt pending device evidence.
A failed unlock swipe followed by a confirmed unlocked lock state returns success
with a warning containing the swipe error.

## Opt-in tap diagnostics

A private daemon running with `--debug` adds `diagnostics: true` to
`request_tap_coordinates`. A rebuilt/re-cut runner returns optional
`tapDiagnostics` and always emits one `tap_diagnostics requested=... base=...
resolved=... appFrame=... screenBounds=... native=... scale=...
deviceOrientation=... interfaceOrientation=... sampleErrors=...` line, including
fast taps, under the same `dev.jasonpearson.automobile` / `GesturePerformer`
subsystem/category. The daemon logs compact JSON with `[CTRLPROXY_TAP_DIAG]`;
its existing 1,000-character line limit can truncate unusually long errors.
Diagnostics stay out of tool/observe output. Debug off omits both request fields;
folded/single-panel taps perform no new platform reads. On a multi-panel mismatch,
taps and single-finger swipes inventory displays and prefer an explicitly targeted
event record; missing private synthesis symbols fall back to the prior coordinate path.
The `soleNonMainScreen` fallback applies only to phone-idiom devices; other idioms
require an application display ID that differs from the main display ID.
Current released runners ignore the flag.
A runner re-cut is required: the newer host alone has no diagnostics to log.

The points are XCUITest's resolved coordinates immediately before the gesture,
not measured touch delivery. Screen metrics and scene/interface orientation
come from the runner process, not the target app; fallback/unknown readings are
explicit. Each failed sample is omitted and named in `sampleErrors`. Only the
necessary app frame attribute is read: no additional window enumeration or
candidate-element snapshot query, and no cheap public bundle identifier getter.
Optional fields include `route`, `targetDisplayId`, `targetDisplayReason`, `deviceIdiom`
(`phone` or `other`), `mainDisplayId`,
`applicationDisplayId`, `screens` (`displayId`, `isMain`), `synthesizedPoint`,
`synthesizedInterfaceOrientation`, `fallbackFrom`, and `deliveryWarning`. A coordinate
route on a panel mismatch emits `eventDisplayMismatch`, also logged by the host at WARN.
When no inventory is read, display fields are omitted and `targetDisplayReason` is
`notSampled`, including folded/single-panel diagnostic taps without forced display targeting.
Debug-only `AUTOMOBILE_IOS_TAP_STRATEGY` accepts `legacy`, `appRelative`,
`appRelativeObserved`, `displayTargeted` (portrait app-frame points), and
`displayTargetedObserved` (unchanged observed points and observation orientation).
Double tap, the separate long-press method, drag, pinch, multi-finger swipe, and
lock-screen swipe do not opt into display targeting. These are routing hypotheses,
not measured touch delivery; display-record routes omit resolved XCUICoordinate points.

On the unfolded Duo, run an isolated private daemon with `--debug`, call
`setPosture opened`, and confirm `observe` reports screenSize 951x669. Run
`tapAt {x:443,y:202}` and `tapOn "Advanced Animations, 15:45"`. Capture the daemon's
`[CTRLPROXY_TAP_DIAG]` lines and runner lines with:

```bash
xcrun simctl spawn <udid> log stream --predicate 'subsystem == "dev.jasonpearson.automobile" AND category == "GesturePerformer"'
xcrun simctl io <udid> screenshot --display=primary-1 /tmp/duo-after-tap.png
```

Take the inner-panel screenshot after the taps. Interpret the readings:

- Resolved point equals requested, but app frame is portrait 669x951, has a
  non-zero origin, or available windows fail to cover the panel: the performer's
  app handle/frame differs from the hierarchy space. Mapping may be needed;
  the fix location is `GesturePerformer.tap` coordinate construction. This
  payload omits window queries, so it cannot settle window coverage alone.
- Resolved point differs by a constant offset or transpose/rotation (such as
  (202,443) or 669-y): XCUITest resolves app-relative coordinates in another
  space. A pure runner mapping gated on the multi-panel inner-panel reading
  is the next fix to investigate.
- Resolved equals requested, app frame is 951x669 at (0,0), and screen metrics
  agree, yet the app does not react: coordinates are right in XCUITest's space.
  Investigate display routing/lower-level event delivery, not coordinate mapping.
- No `tap_diagnostics` runner line: the released runner predates this change;
  re-cut the runner first.
- Non-empty `sampleErrors`: the named read failed on the second display; report
  the exact strings.

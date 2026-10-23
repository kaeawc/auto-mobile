# CtrlProxy Swift-6 rewrite — planning notes

> **Historical.** These notes record the Swift-6 migration. The "Rewrite" name has since been
> retired: the SPM product and target `CtrlProxyRewrite` are now `CtrlProxy`
> (`ios/control-proxy/Sources/CtrlProxy`), and `CtrlProxyRewriteTests` is now `CtrlProxyTests`.
> Identifiers below keep their original names for history.

Notes for the `ios/control-proxy` Swift-6 concurrency rewrite. Start with [STATUS.md](STATUS.md)
for current state, archetype decisions and the race ledger.

## Approach

Parallel reimplementation, not in-place migration: the old `CtrlProxy` stayed as a behavioral
oracle (Swift 5 mode) while `CtrlProxyRewrite` was brought up under strict Swift 6 concurrency
and verified by differential parity against the frozen wire contract. The oracle is now
retired. Phases 0-7 (scaffold, pure core, networking, off-main SDK layer, `@MainActor` UI,
PerfProvider, CommandHandler/coordinator, cutover) are complete; see [STATUS.md](STATUS.md) for the
current state, archetype decisions and race ledger.

Physical-device VoiceOver Settings lookup prefers a stable `VoiceOver` accessibility identifier,
then the sourced English label. If neither is exposed, it opens the first Accessibility
navigation cell and accepts the sole switch on that sub-page. An unmatched switch on the
Accessibility root is never tapped, nor is an ambiguous sub-page with multiple switches. Apple
Settings translations are not bundled, so there is no verified localized label table; a
reordered first cell or changed sub-page structure still needs physical-device validation.

## Deferred-fixup index

Post-concurrency (Phase 8) improvements deferred so the migration landed parity-first.
Append new entries as they are uncovered.

| Note                                                            | Area                              | Parity risk                                                            | Status                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [hierarchy-merger-geometry](fixup-hierarchy-merger-geometry.md) | `HierarchyMerger` bounds matching | Mixed (containment: none; ±tol: intentional, approved behavior change) | Implemented; golden replay shows no output change on real pairs                                                                                                                                                                                                                                                                                                                            |
| dead API: `ElementLocator.getCachedElement`                     | ElementLocator                    | None                                                                   | Resolved: dropped in the port                                                                                                                                                                                                                                                                                                                                                              |
| `Timer` protocol shadows `Foundation.Timer`                     | PerfProvider/scheduling           | None                                                                   | Resolved: renamed `ProxyTimer`                                                                                                                                                                                                                                                                                                                                                             |
| `GesturePerformer` keyboard-focus / keyboard-visibility polling | GesturePerformer                  | Deadline-edge probes detect conditions met during an overrunning sleep | Resolved: all four waits (focus, visibility, close, destructive-key post-condition) await `KeyboardWait` with an injected monotonic `Clock`, yield the main actor between probes and check the condition after the final sleep. The waits honour task cancellation, but the serial command-chain tasks are unstructured and never cancelled, so cancellation is unreachable in production. |
| PerfProvider is an over-elaborate interval accumulator          | PerfProvider                      | None                                                                   | Resolved: flat interval records with direct duration math build the existing `PerfTiming` shape on demand; injected `any PerfTracking` and pooled flush remain                                                                                                                                                                                                                             |

## Beyond ctrl-proxy: native-Swift landscape

**Two ctrl-proxy structure simplifications were evaluated and rejected (do not re-litigate):**

- The server runs _inside the XCUITest runner_ (`CtrlProxyUITests-Runner.app` → `testRunService`),
  not in `AutoMobileTest` (only the required UI-test _host_; blank VC). Cross-app hierarchy
  reads and gesture injection come from `XCUIApplication`/`XCUIElement`, a privilege
  `testmanagerd` grants only to a UI-test process; no entitlement grants it, so it can never be a
  packaged/App-Store app. `control-proxy.ipa` is a zip of `Build/Products/`.
- **macOS CLI target**: useless, since on macOS the `ElementLocator`/`GesturePerformer` capability
  compiles out (`#if os(iOS)`) and XCUITest is unavailable to a plain executable. The `#else`
  non-iOS path is only a fast host compile gate.
- **Pure SPM instead of `CtrlProxy.xcodeproj`**: not feasible. SPM cannot emit the
  `bundle.ui-testing` product / `XCTRunner.app`, an iOS app host, the `.xctestrun`, or the
  signing/install orchestration. SPM (fast host logic + tests) plus XcodeGen (`project.yml`, the
  only thing that builds the shipped runner) is the minimal form.

**Other native-Swift components needing their own Swift-6 pass (ranked, separate work):**

- **`ios/auto-mobile-sdk`** (in-app instrumentation SDK; ctrl-proxy links it for wire models):
  largest need, architecturally the pre-rewrite ctrl-proxy. CI builds it macOS-only, so its iOS
  UIKit `@MainActor` surface was unchecked. #5839 moved the SDK and highlight-core targets to the
  Swift 6 language mode with zero concurrency diagnostics on the macOS host build and a generic
  iOS Simulator `xcodebuild`, converting most types to checked `Sendable` (storage drivers,
  network mock/capture, navigation adapters, API facades). Remaining `@unchecked Sendable`
  types and why:
  - non-Sendable NotificationCenter observer tokens: `AutoMobileSDK`, `AutoMobileNotificationObserver`,
    `AutoMobileOsEvents`, `ViewHierarchyTracker`
  - non-Sendable injected closures / `Thread?`: `AutoMobileCrashes`, `AutoMobileHangs`
  - weak non-Sendable delegate: `NotificationActionHandler`
  - injected `any NSLocking`, listener existentials, weak server reference: `SdkHierarchyServer`
  - owner decision D52: `UserDefaultsInspector` (non-Sendable public listener values),
    `SQLiteDatabaseDriver` (raw `OpaquePointer` handles), `AutoMobileWebViewBridge` (mutable
    `weak var WKWebView`, main-actor WebKit delegate requirements)
  - `AutoMobileURLProtocol` is `final` and `@unchecked Sendable` (all instance and static state
    behind `OSAllocatedUnfairLock`); `final` is not a source break since the class is `public`,
    not `open`.
  - Intentionally non-lock: `AutoMobileCrashes.signalCrashFilePath` / `previousSignalHandlers`
    (the C signal handler must stay lock-free and async-signal-safe).
  - Main-actor sizing: `ViewHierarchyWalker` is a public enum with synchronous `walk(bundleId:)` /
    `computeHash(_:)`, so whole-type `@MainActor` would change public API; use nonisolated
    public facades over an isolated internal implementation. `SdkHighlightOverlayManager` is
    internal, so whole-type `@MainActor` is possible; its caller is `SdkHierarchyServer`'s
    off-main HTTP continuation.
  - Floor: iOS 17 / macOS 15 (owner decision 2026-10-02); use `OSAllocatedUnfairLock`, since
    `Mutex` needs iOS 18.
- **`ios/XCTestRunner`** (standalone MCP-client XCTest wrapper; the iOS analog of the Android JUnit
  runner, not an XCUITest harness, no code coupling to ctrl-proxy): moderate, in place. Already
  tools-6.0/`.v5`. Work concentrates in 2 MCP-client classes (fields mutated from `@Sendable`
  closures) plus ~4 singleton annotations. Surfaces a real bug: `TestTimingCache.clear()` mutates
  state without `loadLock`.
- **`ios/screen-capture`** (independent macOS CLI video helper; frozen stdout protocol): moderate,
  future-proofing with no current race. Per-target `.v6`, `@Sendable` on ~17 closures, make 5
  capture/writer classes Sendable; expect ScreenCaptureKit/AVFoundation `@MainActor` churn. Easy to
  verify (macOS target). Keep `runBlocking` as is.
- **`ios/Playground`** (internal SwiftUI SDK demo/test host, not shipped): defer; follows
  `auto-mobile-sdk`.

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

An iPad windowed app (iOS 27 "Windowed Apps", #6635) also produces an app/screen
size mismatch. There the application frame and the snapshot hierarchy are
window-relative with origin (0,0), while the app's window element and synthesized
events use screen space. On the mismatch path the runner reads the observed app's
`windows.firstMatch.frame` once per gesture. When that window has the app frame's
size and a different origin, an automatic point-offset tap, swipe, or drag adds the
window origin: `base` is the window origin and `coordinateConstruction` is
`windowOriginPlusPointOffset`. Full-screen apps and iPhones have no mismatch and
perform no extra read. Normalized (multi-panel) selections and a forced `legacy`
strategy are not translated. SpringBoard alerts merged into a windowed app's
hierarchy arrive in screen space, so observe subtracts the same translation from
their bounds (one `windows.firstMatch.frame` read, only when an alert is present).
Every observed node is then window-relative and the single gesture rule holds.

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

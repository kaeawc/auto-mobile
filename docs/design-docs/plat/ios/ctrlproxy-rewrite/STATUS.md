# CtrlProxy Swift-6 rewrite — status & resume guide

**This is the authoritative "where we are / how to continue" doc.** A fresh session
can be given minimal guidance — e.g. _"we just finished Phase 2; read
`docs/design-docs/plat/ios/ctrlproxy-rewrite/STATUS.md` and proceed into Phase 3"_ —
and orient entirely from here. See [README.md](README.md) for the fixup-note index
and the amended phase plan.

**Phase 7 cutover is COMPLETE (7E done): the Swift-6 rewrite is the sole `CtrlProxy` implementation
and the reference oracle is retired.** The production XCUITest runner compiles + runs `CtrlProxyRewrite`;
the full observe→gesture→hierarchy loop passes on the iOS 26.5 sim; the reference impl, its unit tests,
and the differential-parity harness are removed (the KEEP wire-contract tests were re-anchored
reference-free; the behavioral-domain parity tests were dropped). Remaining: **Phase 8** post-concurrency
fixups (README index) + the still-deferred Phase-2 loopback/connection scenarios as iOS UI tests.

Validation gate is now SPM `-warnings-as-errors` (196 rewrite tests, 0 failures; single module) +
the iOS-sim `build-for-testing` + the on-device runner smoke. **Runtime caveat (durable):** validate
on the iOS **26.5** sim, not the 27.0 **beta** (host-app launch flake — see the Phase-7D note); pin
the 26.5 device UDID (`name=iPhone 17` is ambiguous across both runtimes).

---

## 1. What this is

A **parallel reimplementation** of the `ios/control-proxy` `CtrlProxy` Swift package
to be clean under Swift 6 strict concurrency, verified by **differential parity**
against the shipped code (which stays as a behavioral oracle) rather than an in-place
migration. Goals: (1) idiomatic Swift-6 concurrency, (2) close real concurrency races
behind production iOS flakiness.

- Branch: `plx/investigation/swift-idiomaticity`. Plain git (no jj). macOS host,
  Swift 6.4 toolchain.
- The **wire protocol is frozen** — the AutoMobile TS MCP server (repo `src/`) speaks
  it. Byte/shape parity is the hard contract; internals are free.

## 2. Build, test, and the gate

Run from the package dir (`cd ios/control-proxy` first — several `swift` invocations
built the wrong package when cwd drifted to the repo root; always `cd` in):

```bash
cd ios/control-proxy
swift build -Xswiftc -warnings-as-errors                 # strict-concurrency compile gate
swift test  -Xswiftc -warnings-as-errors --filter CtrlProxyRewriteTests   # the parity gate
```

CI runs `scripts/ios/swift-test.sh` = `swift test -Xswiftc -warnings-as-errors` over the
package, so **warnings-as-errors is the real gate** (e.g. an unused `removeAll()` result
fails it). Current: **229 rewrite tests, all green; full package 533 (reference) + 229
(rewrite) green.** (There is a known pre-existing flake in the reference suite —
`WebSocketServerTests.testFragmentedCommandReassemblesEndToEnd`, a `RealSocketClient`
loopback timing flake — unrelated to the rewrite; passes in isolation.)

**cwd hazard (bit us again in Phase 4):** run `swift` with an explicit
`--package-path ios/control-proxy` (or `cd` in first). From the repo root, `swift test`
resolves a _different_ package (e.g. `ios/auto-mobile-sdk`, which has its own unrelated
pre-existing Swift-6 `URLProtocol: Sendable` error) and the failure looks like a rewrite
regression when it is not.

## 3. Package layout (post-cutover)

`Package.swift` (tools 6.3, platforms iOS 17 / macOS 15). As of Phase 7E the per-target-language-mode
scheme is gone with the reference — `CtrlProxyRewrite` is the sole implementation:

- `CtrlProxyRewrite` (`Sources/CtrlProxyRewrite/`) + `CtrlProxyTestSupport` + `CtrlProxyRewriteTests`
  → all `.swiftLanguageMode(.v6)`. `CtrlProxyRewriteTests` is now a single-module suite (196 tests).
- **Historical:** the reference `CtrlProxy` + `CtrlProxyTests` targets were pinned `.v5` as a
  behavioral oracle during the migration and were retired in Phase 7E (§5).
- Xcode/XcodeGen: the `CtrlProxyUITests` target compiles `Sources/CtrlProxyRewrite` directly
  (Swift-6 / complete / iOS-17 per-target settings) — see §9/Phase 7C. Fakes live in
  `CtrlProxyTestSupport` (not the shipped product).

## 4. Parity-harness technique (important, reused everywhere)

The module `CtrlProxy` and the type `CtrlProxy` collide, so `CtrlProxy.WebSocketRequest`
is ambiguous. **Workaround:** per-module helper files that each import ONE module
(`ReferenceX.swift` imports `CtrlProxy`, `RewriteX.swift` imports `CtrlProxyRewrite`),
expose module-agnostic returns (Data / tuples / Int / normalized `[String:Any]`), and a
test file imports neither module and diffs the two. Use `@testable import` to reach
internal symbols. Diff strategies, by strength: Mirror-normalized request decode against
the shared fixture; **sorted-key encoded-byte** equality; scalar/string equality; and —
for `Date()`-stamped responses — `timestamp`-stripped JSON-object comparison. The shared
wire fixture is `test/fixtures/ios-ctrlproxy-request-snapshots.json`.

## 5. Status by phase

| Phase | What                                                                                                                                              | Commit(s)                                                                                       | State                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 0     | Scaffold targets + Models (request half) + no-op `CtrlProxy` + decode-parity gate                                                                 | `50579ab03`                                                                                     | ✅                                       |
| 1     | Pure/stateless core                                                                                                                               | `8aba998ca` `e683e6453` `e7589dd40` `499da2805`                                                 | ✅                                       |
| 2     | Networking core (queue-confinement)                                                                                                               | `0a56900dc` `004e54279` `bae5cadaa` `84430e00d`                                                 | ✅ core                                  |
| 3     | Off-main SDK layer (cache lock-confined + transactional; SDK/DB clients async; OSLogReader)                                                       | `f705e31ca` `d291db66c` `54ec41e39` `8ba273873` `1d8c08ba1` (+ de-flake `be92b2628`)            | ✅                                       |
| 4     | `@MainActor` UI (ElementLocator, GesturePerformer, HierarchyDebouncer, DisplayLinkFPSMonitor, VoiceOver)                                          | `a0646e713` `f715fc90a` `8c634c77a` `957916c1f` `400a3a42e` `d209ad95c` `e1f4c4d86` `2b1373016` | ✅                                       |
| 5     | PerfProvider (TaskLocal call-tree + confined pool)                                                                                                | `11d8e192a`                                                                                     | ✅                                       |
| 6     | CommandHandler (Sendable POD router, `handle` async) + async serial dispatch + `CtrlProxy` coordinator                                            | `5ce6c75bd` `333e236f8` `089e4e0da` `1fb695e35` `d49358121`                                     | ✅                                       |
| 7A    | Wire rewrite into XcodeGen + first green iOS-sim compile (host-hidden `ElementLocator` init fixed)                                                | `12e7c80a1`                                                                                     | ✅                                       |
| 7B    | iOS strict-concurrency warning cleanup (`DeviceRotation`/`DefaultVoiceOverToggle`/runner) — 0 warnings + runtime-validated on sim                 | —                                                                                               | ✅                                       |
| 7C    | Point the production runner at the rewrite (repurpose `CtrlProxyUITests` target → compiles `Sources/CtrlProxyRewrite`; zero TS/script churn)      | —                                                                                               | ✅ (middle route)                        |
| 7D    | On-device validation — full observe→gesture→hierarchy loop (`HierarchyIntegrationTests`) green on the **iOS 26.5** sim; `testServiceStarts` green | —                                                                                               | ✅ (use 26.5, not the 27.0-beta runtime) |
| 7E    | Retire the reference (KEEP wire tests re-anchored reference-free; behavioral parity dropped; reference impl + targets + harness removed)          | `739dfb0d6` `bbddf06c7` `af5841806`                                                             | ✅                                       |
| 8     | Post-concurrency fixups (see README index)                                                                                                        | —                                                                                               | ◻️                                       |

**Ported so far** (all one-type-per-file, `Sendable`, differentially verified unless
noted): the full inbound + response-envelope wire models (`Models/`, incl. `Models/Sdk/`),
`CommandError`, `StructuralHasher`, `HierarchyMerger`, gesture/geometry helpers
(`PinchFallback`, `MultiFingerSwipeDiagnostics`, `SemanticLinkActivation`,
`DeviceRotation.fromOrientationName`, `RotationCaptureSample`), `WebSocketFraming` (RFC-6455
codec + reassembly), `WireError`, `Data.sha1`, `ErrorResponse.build`, `SdkEventBuffer` +
`ConnectionRegistry` (lock-confined `Sendable`), the seams (`ByteChannel`/`ByteChannelState`/
`WebSocketResponding`/`NWByteChannel`), `WebSocketConnection` (queue-confined; adversarially
verified faithful across 6 facets), and `WebSocketServer` (queue-confined).

**Phase 3 added** (off-main SDK layer): the SDK DB result models
(`SdkExecuteSqlResult`, `SdkTableDataResult`, `SdkTableStructureResult`, `SdkDatabaseInfo`,
`SdkStorageCapabilities`, `SdkColumnInfo`, `SdkCoreDataStoreRegistration`,
`SdkStorageDiagnostic`) + `SdkHierarchyServerInfo` + the six DB response envelopes
(`ExecuteSqlResponse`/`ListDatabasesResponse`/`StorageCapabilitiesResponse`/
`ListTablesResponse`/`TableDataResponse`/`TableStructureResponse`), all `Codable & Sendable`;
storage inspection (`StorageSuiteInfo`, `StorageEntry`, `StorageError`, `StorageInspecting`,
`DefaultStorageInspecting` — stateless `Sendable`); `SdkHierarchyClient`/`SdkDatabaseClient`
as async `Sendable` clients over an injected `HTTPRequesting` seam (+ `SdkHighlightOutcome`,
`SdkDatabaseError`, `SdkHierarchyFetching`/`SdkDatabaseFetching`); `OSLogReader` +
`OSLogReaderHolder` (queue-confined); `BundleId.normalized`; `SdkHierarchyCache`
(lock-confined `Sendable`, **not** an actor — see §6/§7) with a transactional `reconcile`
closing race #2, `SdkHierarchyCaching`, and `SdkHierarchyExtractor`. Connection
`onSdkEventBatch`/`drainLogEvents` seams exercised end-to-end in tests (production wiring is
Phase 6). 102 rewrite tests (from 42), all green; full package 533 + 102 green.

**Phase 4 added** (`@MainActor` UI domain + its lock-confined support). Sub-steps landed
one green commit each: **4A** UI-domain foundation seams (`TimeProviding`/`ProxyTimer`,
the `catchingObjCException` free-function bridge replacing `runOnMainThread`, main-thread
runner); **4B** `FrameContext` as a lock-confined `Sendable` (shared-encoder smell →
fresh-per-call) + the `FrameContextRecording` server seam; **4C** VoiceOver providers as
`Sendable` structs; **4D** `HierarchyDebouncer` as an `@MainActor` state machine; **4E**
`DisplayLinkFPSMonitor` as an `@MainActor` owner of its `CADisplayLink` (closes the orphan
race) + `PerformanceSnapshot` / `broadcastPerformanceUpdate` / `PerformanceUpdateResponse`
(deferred from Phase 2); **4F-1** the rotation-capture epoch (`RotationChangeMonitor`) as a
genuinely-`Sendable` lock-confined type; **4F-2** `ElementLocator` as `@MainActor`
(closes race #1 — the multi-hop capture is one main-actor transaction; drops the dead
`getCachedElement`); **4G** `GesturePerformer` as `@MainActor` (per-op `DispatchQueue.main.sync`
hops removed; the `NSException` guard moves inside via `catchingObjCException` +
`catchingObjCExceptionNonThrowing`; `clipboardShadowQueue` dropped for plain main-actor
state; host-tested pure statics are `nonisolated static`) + the `Sendable ScreenshotCapture`,
the `@MainActor GesturePerforming` protocol, and `DeviceRotation`'s gesture-orientation
members. The `@MainActor`/iOS-only bodies compile on the macOS host **only** through their
`#else` stubs and the `nonisolated static` pure helpers; full iOS compile lands at Phase 7
(Xcode). 216 rewrite tests (from 102), all green; full package 533 + 216 green.

**Phase 5 added** (`PerfProvider` engine + `MutablePerfEntry`). The active call-tree
moved from `Thread.current.threadDictionary` to a `@TaskLocal` bound per operation by a
sync/async `withScope` (the approved §9.3 call — see §6); the completed-root pool +
debounce counters moved from `NSLock` + fields to an `OSAllocatedUnfairLock<Shared>`
(genuinely `Sendable`); the reference singleton was **dropped** (injected `any
PerfTracking` + Phase-6-owned instance). Completed roots are snapshotted to immutable
`PerfTiming` **eagerly** (before entering the pool) so no mutable node lives behind the
lock. Verified by a differential parity harness (per-module driver + neither-import
sorted-key encoded-byte diff) over a 15-script corpus, plus unit tests for the
load-bearing `@TaskLocal` nesting across a real off-main→`@MainActor` executor hop,
`track`/`trackAsync`, and out-of-scope no-op behavior. **Engine-level parity only** — it
does not prove production _emits_ `perfTiming`; that integration test is a Phase-6
obligation (see §8). 227 rewrite tests (from 216), all green; full package 533 + 227 green.

**Phase 6 added** (`CommandHandler` router + async serial dispatch + `CtrlProxy`
coordinator). Landed one green commit each: **6A** the 13 remaining handler-built response
envelopes (Screenshot/Keyboard/Rotate/CurrentFocus/TraversalOrder/VoiceOver×2/Storage×3/
Network×3) ported one-per-file `Codable & Sendable` + `WebSocketResponsePayload`
conformance for every envelope `handle` returns; **6B** additive seams (`PerfTracking.withScope`
async requirement; `@MainActor HierarchyDebouncing: Sendable`; `: Sendable` refinements on
`ElementLocating`/`GesturePerforming` so the `Sendable` router can hold the `@MainActor`
existentials); **6C–E** the `CommandHandler` port (a `Sendable` POD, `handle` **async** →
`any WebSocketResponsePayload`; `await`s the `@MainActor` UI collaborators + async SDK
clients, calls the lock-confined ones synchronously; `PerfProvider.track` re-expressed as
`tracked`(`@MainActor`)/`trackedAsync` over `any PerfTracking`; the cached-SDK read path uses
`reconcile`), the server's **async serial task-chain** dispatch (`commandTail` lock +
`await previous?.value` preserves per-command ordering without a blocking hop) bracketing
decode→handle→flush→encode in `perf.withScope`, and the `@MainActor` `CtrlProxy` coordinator
filling the production seams (`onSdkEventBatch`/`drainLogEvents`/`onClientPresenceChanged`
via a late-bound weak box); **6F** two parity layers (46-command routing parity +
the §8 integration `perfTiming` parity through `WebSocketServer.handleMessage`); **6G** an
adversarial multi-lens review that caught one real `perfTiming` wire divergence — for
gestures routed through `performContextCheckedGesture` the reference's _thread-local_ perf
splits the gesture-nested `track` onto the main thread's empty stack (a separate root under a
synthetic `total`), so the rewrite now runs the gesture inside a **fresh `perf.withScope`** to
reproduce that split (a plain `MainActor.run` had nested it via the propagated task-local).
229 rewrite tests (from 227), all green; full package 533 + 229 green. **Coordinator caveat:**
its iOS (`canImport(XCTest) && os(iOS)`) branch is not host-compiled — full compile lands at
Phase 7 (Xcode).

**Phase 7A added** (wire rewrite into XcodeGen + first green iOS-simulator compile). An
_additive_ `CtrlProxyRewriteUITests` `bundle.ui-testing` target compiles `Sources/CtrlProxyRewrite`
directly (so XCUITest is visible to the `@MainActor` UI domain), pinned to the SPM `.v6` contract
via per-target settings (`SWIFT_VERSION = 6.0`, `SWIFT_STRICT_CONCURRENCY = complete`,
`IPHONEOS_DEPLOYMENT_TARGET = 17.0` — the rewrite's `OSAllocatedUnfairLock` floor; the project
default is 15.0/Swift-5/`targeted`), embedding `ObjCExceptionCatcher`, wired into the app scheme's
test action. The reference `CtrlProxy`/`CtrlProxyUITests` targets are left pristine (retired only
once the rewrite's UI-test smoke passes on a simulator — §9). A minimal `@MainActor` runner
(`Tests/CtrlProxyRewriteUITests/`) drives the public `CtrlProxy` surface. `build-for-testing` of the
app scheme against `iphonesimulator27.0` **succeeds** — the first time the `#if canImport(XCTest) &&
os(iOS)` bodies (`ElementLocator`/`GesturePerformer`/`DisplayLinkFPSMonitor`/`DeviceRotation`/
VoiceOver) **and** the `CtrlProxy` coordinator's iOS branch compile. One genuine host-hidden error
fixed: `ElementLocator`'s iOS `init(application:perf:)` was `public` while `PerfTracking` is internal
(a `public` init can't expose an internal type; the host `#else` stub hid it) → narrowed to `internal`
(only constructed in-module; cross-module tests use fakes). SPM parity gate unchanged (229 green,
reference host build green).

**Phase 7B added** (iOS strict-concurrency warning cleanup — applied + runtime-validated). The 7A
iOS compile was green but carried **~149 non-fatal Swift-6 strict-concurrency warnings** in the
iOS-only bodies that no gate catches (SPM never compiles them on the macOS host; Xcode keeps
SDK-inferred main-actor-isolation violations _non-promotable_ even under
`SWIFT_TREAT_WARNINGS_AS_ERRORS = YES`) — genuine concurrency-model gaps (nonisolated code touching
`@MainActor` UIKit/XCUITest APIs). Now **0 source warnings** (only the benign "AppIntents metadata
skipped" build note remains). All `DeviceRotation` callers (`ElementLocator`/`GesturePerformer`) are
already `@MainActor`, and the `capture {}` operation closures already compiled clean via region-based
isolation, so the fix was localized:

- `DeviceRotation`: `currentGestureInterfaceOrientation()` → `@MainActor` (all callers `@MainActor`,
  hop-free, behavior-identical). `XCUIDeviceRotationSampler.currentRotation()` reads
  `XCUIDevice.shared.orientation` through the _host-compiled_ nonisolated `RotationSampling` protocol →
  wrapped in `MainActor.assumeIsolated` (call-graph-provably main-thread; avoids a host-protocol ripple).
  `DeviceOrientationChangeSignal.init`/`startObserving`/`deinit` touch `UIDevice.current` from a
  nonisolated `RotationChangeSignaling` conformance → `assumeIsolated` (init/startObserving provably
  main via `startMonitoring()` from `@MainActor` `ElementLocator.init`; **`deinit` is unreachable dead
  code** — process-lifetime `static let` — the `assumeIsolated` documents the contract a nonisolated
  `deinit` can't express). `startObserving` assigns `observer` _inside_ the closure — the returned
  `any NSObjectProtocol` is not `Sendable` and can't cross back out of the `@MainActor` region.
- `VoiceOverToggling.setVoiceOver` → `@MainActor` (the default impl drives XCUITest); the async
  `Sendable` `CommandHandler.handleSetVoiceOverState` now `await`s it (consistent with §6 — the handler
  already `await`s its `@MainActor` UI collaborators). Ripple absorbed: the protocol, `DefaultVoiceOverToggle`,
  the test fake in `RewriteVoiceOver.swift` (one localized `assumeIsolated`).
- Runner: dropped the `tearDownWithError` override (a nonisolated XCTest override touching the
  `@MainActor` `service` forces an `assumeIsolated` that trips region isolation, "sending self") — each
  `@MainActor` test method now stops its service via `defer` (same cleanup, all main-actor context).

**Runtime-validated:** with an iOS 27.0 simulator runtime installed, `testServiceStarts` **runs green**
on `iPhone 17` (`[CtrlProxy] Service started` → `Service stopped`), exercising the coordinator's
`@MainActor` init path (incl. `DeviceRotation` signal init `assumeIsolated`) and the full server
start→stop lifecycle on-device — so the `assumeIsolated` main-thread assumptions do not trap. SPM
parity gate unchanged (229 green; host build 0 warnings).

**Phase 7C added** (runner switch — the "middle route"). The production XCUITest runner now compiles
and runs the rewrite. Chosen mechanism: **repurpose the existing `CtrlProxyUITests` XcodeGen target**
to source `Sources/CtrlProxyRewrite` (with the Swift-6/`complete`/iOS-17 settings) instead of the
reference `Sources/CtrlProxy`, keeping the target name, `CtrlProxyUITests-Runner.app`, the xctest
bundle, and the `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService` identifier unchanged —
so the TS MCP layer (`IOSCtrlProxyManager`/`IOSCtrlProxyBuilder`/`IOSCtrlProxyProcessClient`, incl. the
fragile daemon process-recovery command-shape matchers) and the `scripts/ios/ctrl-proxy-*.sh` drive it
**with zero changes** (no TS touched → typecheck baseline unaffected). The runner class is renamed to
`CtrlProxyUITests` (a minimal `@MainActor` runner over the public `CtrlProxy` surface); the additive
`CtrlProxyRewriteUITests` target/dir from 7A is removed, and the reference-only UI tests
(`PrivacyResourceMappingTests`, the fake/singleton-dependent `testHierarchyIncludes…`) are dropped
(to be re-ported against the rewrite in 7D). The reference impl stays fully buildable as the
differential-parity oracle (SwiftPM `CtrlProxy` library + `CtrlProxyRewriteTests`; the Xcode `CtrlProxy`
framework target is untouched) — it just no longer backs an on-device runner. Validated: `build-for-testing`
green (0 errors, 0 source warnings) and the **production** identifier
`CtrlProxyUITests/CtrlProxyUITests/testServiceStarts` runs green on iPhone 17. SPM gate: 229 green.

**Phase 7D added** (on-device validation — **complete**; reference kept). The rewrite's `@MainActor`
UI domain is now validated end-to-end on a simulator:

- `testServiceStarts` green on iPhone 17 — the `@MainActor` coordinator init path (incl.
  `DeviceRotation` signal-init `assumeIsolated`) + server start→stop.
- The reference's rich integration test (`testHierarchyIncludesTypedTextInputsMissingFromSnapshotTree`)
  was ported into `Tests/CtrlProxyUITests/HierarchyIntegrationTests.swift` (against the rewrite;
  `@MainActor`; explicit `perf: PerfProvider()`) and runs **green on the iOS 26.5 release runtime**
  (0 failures, 7.2 s): it launches the host app's snapshot-gap fixture, then drives the rewrite's
  `ElementLocator` + `GesturePerformer` through hierarchy extraction (incl. the typed-text-input path
  the XCUITest snapshot tree omits — asserting `role`/`clickable`/`actions`/`bounds`), a tap,
  `typeText`, and secure-field masking (`•`×6, `password="true"`).

**Runtime caveat (durable):** validate on the **iOS 26.5** runtime, not the **iOS 27.0 beta** — on
27.0-beta the host app fails to reach its fixture VC (XCUITest "Unable to monitor event loop"; the app
stays on a launch-screen-like tree; xcodebuild _teardown_ then hangs ~10 min though the test body runs
in ~13 s). Not a rewrite bug (the rewrite's `getViewHierarchy` faithfully extracts whatever rendered —
a diagnostic run returned a real 15-node tree even on the beta). The ported test is `XCTSkipUnless`-
guarded on the fixture appearing, so it hard-asserts on 26.5 and skips (not red-fails) on 27.0-beta.

**Consequence:** the 7E gate (a trusted full observe→gesture→hierarchy loop) was cleared here.

**Phase 7E added — reference retired (cutover complete).** Landed as three commits: **1/3**
(`739dfb0d6`) re-anchored the Codable wire-model parity tests (WireDecode, ResponseModel,
SdkDatabaseModel, HierarchyModel, PerformanceWire) reference-free via a new `JSONGolden` helper
(decode→sorted-encode must be idempotent + preserve every wire field the input carried — containment
tolerates a model materializing a defaulted field; an explicit-null optional == omission); **2/3**
(`bbddf06c7`) rewrote Framing + Geometry as reference-free invariant / known-value tests (byte-blob
outputs can't be literal goldens); **3/3** (`af5841806`) deleted `Sources/CtrlProxy`, `Tests/CtrlProxyTests`,
all 17 `Reference*` helpers, the 10 behavioral-domain `*ParityTests` + their orphaned `Rewrite*`
helpers/fixtures, and dropped the reference from Package.swift (product/target/`CtrlProxyTests` +
`CtrlProxyRewriteTests`' dep + the `.v5` modes), project.yml (framework + unit-test targets + the app's
embed + scheme), and the `CtrlProxyTests.xctest` checks in the `ctrl-proxy-*` scripts. `CtrlProxyRewrite`
is now the sole implementation; `CtrlProxyRewriteTests` is a single-module suite (196 tests). Kept
`RewriteConnection`/`ConnectionTestRecorder` (`ConnectionSdkSeamTests`) and `HTTPTransportStub`
(SDK-client tests). Validated: SPM build 0 warnings + 196 tests green; iOS-sim `build-for-testing`
green (0/0); production runner smoke green on the 26.5 sim.

## 6. Archetype map & load-bearing decisions

- **iOS 17 floor rules out `Synchronization.Mutex`** (needs iOS 18). Use actors,
  `OSAllocatedUnfairLock` (iOS 16+), or GCD queue-confinement.
- **Queue-confinement** = `final class … @unchecked Sendable` + private serial
  `DispatchQueue` + `dispatchPrecondition(.onQueue(queue))` on on-queue methods; public
  API funnels via `queue.sync`/`async`; the `@unchecked` is justified by that
  confinement, not a lock. (`WebSocketServer`, `WebSocketConnection`, `NWByteChannel`,
  `OSLogReader` — the last **must** be queue-confined, not lock-confined, because
  `OSLogStore` is not `Sendable` and so cannot live in an `OSAllocatedUnfairLock<State:
Sendable>` in this toolchain.)
- **Lock-confined Sendable collections** where a synchronous cross-thread path can't
  `await` (broadcast; or a write on the network queue): `OSAllocatedUnfairLock<State>` →
  genuinely `Sendable`, no `@unchecked`. (`SdkEventBuffer`, `ConnectionRegistry`, the
  server's upgraded-client set, and **`SdkHierarchyCache`**.)
- **Cache = lock, not actor (revises the original Phase 3 plan; approved by Paul).** The
  plan first proposed `SdkHierarchyCache` as an `actor`. But its write path
  (`POST /sdk-events` → `SdkHierarchyExtractor` → `update` → hierarchy-refresh broadcast)
  runs synchronously and in-order on the connection's serial queue; an `actor` is reachable
  from that sync closure only via a detached `Task`, which would **reorder** cache updates
  across rapid POSTs (caching a stale hierarchy) and move JSON decode off the serial queue —
  a _new_ ordering hazard, the opposite of this rewrite's goal. A lock-confined cache keeps
  that path synchronous and ordered, needs no `@unchecked`, and still closes race #2 via a
  single-`withLock` transactional `reconcile`. The read path (Phase 6 `CommandHandler`, a
  `Sendable` POD) calls it synchronously — no `await`.
- **`CommandHandler` must stay a `Sendable` POD router, NOT `@MainActor`** — else its
  blocking SDK HTTP/DB calls freeze XCUITest and starve `/health` (#5374). It `await`s
  `@MainActor` UI collaborators and off-main SDK actors.
- **`handle -> Any` is replaced by `-> any WebSocketResponsePayload`** (`Sendable &
Encodable`). `encodeResponse` keeps the `WebSocketResponse`/`HierarchyUpdateResponse`
  downcasts for `perfTiming` injection; everything else encodes straight through.
- **Coders are fresh-per-call** (`.sortedKeys`) — closes the reference's shared-mutable
  `JSONEncoder` smell; byte-identical since the config matches.
- **`ObjCExceptionCatcher` survives** into the `@MainActor` phases — Swift still can't
  catch XCUITest `NSException`s; it just moves _inside_ the `@MainActor` block.
- **PerfProvider active call-tree = `@TaskLocal`, not thread-local (resolves §9.3;
  approved by Paul).** The reference kept the open-entry stack per _thread_ so an
  operation on one thread never nested under an in-flight operation on another (#3635).
  But the rewrite made `ElementLocator` `@MainActor`, so one hierarchy request now spans
  the command queue _and_ the main actor within a single task; a thread-local would split
  the tree at that executor boundary (`getViewHierarchy` would land as a separate root). A
  `@TaskLocal` propagates across the `await` into the `@MainActor` collaborator _within the
  same task_, reproducing the reference's single-threaded tree shape — proven byte-identical
  by the parity corpus and by the off-main→`@MainActor`-hop unit test. Bound per operation by
  `withScope` (sync + `nonisolated(nonsending)` async overloads); outside any scope the
  imperative calls are safe no-ops (perf timing is diagnostic, not wire-critical). The scope
  is `@unchecked Sendable`, justified by single-task-serial mutation — production opens no
  parallel perf blocks across child tasks. **Deliberately faithful port**: it is an
  over-elaborate way to compute a handful of intervals; the `os_signpost`/direct-interval
  simplification is a queued Phase-8 fixup (README index), not part of this migration.
- **PerfProvider pool = `OSAllocatedUnfairLock<Shared>`, singleton dropped, eager
  conversion.** The completed-root pool + debounce counters use the lock-confined-`Sendable`
  archetype (no `@unchecked`), and `flush()` still drains the whole pool so command and
  polling timings report together. The reference singleton (`nonisolated(unsafe) static` +
  double-checked `NSLock`) is dropped — collaborators inject `any PerfTracking` and the
  Phase-6 coordinator owns the one instance, so the task-local needs no per-instance key. A
  completed root is snapshotted to an immutable `PerfTiming` _before_ it enters the pool
  (the reference converted lazily at flush; eager is behaviorally identical since a root and
  its children are fully timed by the time the root completes) so no mutable node is stored
  behind the lock.
- **Async command dispatch = serial `Task`-chain (Phase 6).** `CommandHandling.handle` became
  `async` (it `await`s the `@MainActor` UI collaborators + async SDK clients), so the reference's
  single serial `commandQueue` was replaced by a serial task-chain: `dispatchCommand` holds an
  `OSAllocatedUnfairLock<Task<Void, Never>?>` (`commandTail`) and each command's `Task` does
  `await previous?.value` before handling. This preserves the reference's per-command ordering
  (issue #5374) without a blocking queue hop, and frees the accept `queue` the instant a command
  is enqueued. `WebSocketServer.handleMessage` is now `async` and brackets
  decode→handle→flush→encode in `perf.withScope` (the §8 wiring).
- **`performContextCheckedGesture` = one `MainActor.run` turn + a FRESH `perf.withScope`
  (Phase 6; the review-caught subtlety).** The reference ran the frame-context validation and the
  gesture together in one `DispatchQueue.main.sync` (atomic). The rewrite runs them in one
  `MainActor.run` (same atomicity, no suspension between the generation read and the gesture) —
  `MainActor.run`, not a blocking `main.sync`, because the perf task-local must reach the gesture.
  **But** the reference's perf is _thread-local_: `performIfCurrent` hops the gesture onto the
  main thread, where that stack is empty, so a gesture-nested `track` (`setText.byResourceId`,
  `pressButton`, …) opens as its OWN root and `flushPerfTiming` wraps the two roots under a
  synthetic `total`. A plain `MainActor.run` would keep the propagated task-local scope and nest
  that track under the handler — a different on-wire `perfTiming` tree. So the gesture runs inside
  a **fresh `perf.withScope`**, reproducing the reference's split exactly (a trackless gesture —
  tap/swipe/drag — leaves the fresh scope empty, harmless). Locked by a `set_text` integration
  parity assertion.
- **`CtrlProxy` coordinator = `@MainActor`, immutable server seams wired via a late-bound weak box
  (Phase 6).** It owns the single instances and injects the server's immutable `@Sendable` seams
  at construction (`onSdkEventBatch` → `SdkHierarchyExtractor.extractIfPresent` + a main-actor
  re-broadcast [the reference `SdkHierarchyRefreshPublisher`, inlined as
  `publishSdkHierarchyRefresh`]; `drainLogEvents` → `OSLogReaderHolder.shared.drain`;
  `onClientPresenceChanged` → client-gated samplers, #5477). Because those closures are built
  before `self` exists and fire off the main actor, they capture a `WeakCoordinator`
  (`@unchecked Sendable`, written once on the main actor during `init`, read only inside
  `Task { @MainActor }`) and hop back to the main actor.

## 7. Race ledger

| #   | Race                                                                                                                                                                                                   | Closed by                                                                                        | State         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------- |
| 3   | `WebSocketServer.listener` unsynchronized (self-stop vs external stop)                                                                                                                                 | queue-confinement                                                                                | ✅ (Phase 2)  |
| 4   | `onClientPresenceChanged` torn closure                                                                                                                                                                 | immutable init-injected `@Sendable`                                                              | ✅ (Phase 2)  |
| 2   | `SdkHierarchyCache` lost-update / dropped-event TOCTOU                                                                                                                                                 | lock-confined + transactional `reconcile` (read→compare→clear in one `withLock`)                 | ✅ (Phase 3)  |
| 1   | `getViewHierarchy` non-atomic multi-hop capture                                                                                                                                                        | `@MainActor` single-transaction (+ the rotation-capture epoch, race-free A→B→A detection)        | ✅ (Phase 4F) |
| —   | OSLogReader overlap (concurrent polls on a global queue; fresh store per poll)                                                                                                                         | serial-queue confinement + single reused `OSLogStore`                                            | ✅ (Phase 3)  |
| —   | DisplayLink orphan                                                                                                                                                                                     | `@MainActor` monitor owns the `CADisplayLink` lifecycle                                          | ✅ (Phase 4E) |
| —   | FrameContext shared encoder                                                                                                                                                                            | lock-confined `Sendable` + fresh-per-call coder                                                  | ✅ (Phase 4B) |
| —   | Perf call-tree mis-nest / cross-scope `end()` pop (#3635) — the reference used thread-local to prevent it; the rewrite's `@MainActor` `ElementLocator` reintroduces an executor hop within one request | `@TaskLocal` call-tree bound per operation by `withScope` (propagates across the hop, same task) | ✅ (Phase 5)  |

## 8. Seams left open (to fill in later phases)

**Filled in Phase 6** (all wired by the `CtrlProxy` coordinator, verified by the routing +
integration parity tests):

- `WebSocketConnection` production hooks: `onSdkEventBatch` → `SdkHierarchyExtractor.extractIfPresent`
  (+ main-actor re-broadcast); `drainLogEvents` → `OSLogReaderHolder.shared.drain`. ✅
- `WebSocketServer.CommandHandling` → the `CommandHandler` router; `PerfTracking` → the Phase-5
  `PerfProvider`; `FrameContextRecording` → `FrameContext`. ✅
- The **`withScope` wiring**: `WebSocketServer.handleMessage` brackets the command path in
  `perf.withScope`, so perf calls accumulate on the wire (proven by the integration test). The
  background hierarchy-polling path runs inside the `@MainActor` `HierarchyDebouncer` (its own
  task); it brackets each instrumented `getViewHierarchy` extraction in a fresh synchronous
  `perf.withScope`, so those background roots reach the shared pool and the next response's
  flush reports them (the reference's relied-on pooled-flush of polling timings). ✅
- The **integration `perfTiming` parity test** (the Phase-5-review obligation): drives real
  requests through `WebSocketServer.handleMessage` in both modules and diffs the `perfTiming`
  tree (`request_hierarchy` and `set_text`). ✅
- `WebSocketResponsePayload` conformance for the DB + handler-built envelopes. ✅

**Still open (Phase 7 / later):**

- `broadcastPerformanceUpdate` landed in Phase 4E. Still deferred from Phase 2: a `127.0.0.1`
  loopback smoke test and more connection scenarios (frames/ping/close/fragmentation/HTTP) on
  the scripted-`ByteChannel` harness (`ReferenceConnectionDriver`/`RewriteConnectionDriver`/
  `ConnectionRecorder`) — good candidates to fold into the Phase-7 Xcode/UI-test build.
- Full iOS compile-verification of the `@MainActor` UI domain **and the `CtrlProxy` coordinator's
  iOS branch** (both host-excluded via `#if canImport(XCTest) && os(iOS)`) lands at Phase 7.

## 9. Phase 7 plan (NEXT) — cutover

Every subsystem is ported and green under the SPM host gate. Phase 7 makes `CtrlProxyRewrite`
the shipping target and retires the reference oracle. This is the first phase that compiles and
runs the `@MainActor`/XCUITest bodies **and** the `CtrlProxy` coordinator's iOS branch (all
host-excluded so far — see §8), so expect the first real iOS-compile fixups here.

**Environment note (this host):** Xcode 27.0 with the `iphonesimulator27.0` SDK **and** iOS
runtimes 27.0 + 26.5 (installed via `xcodebuild -downloadPlatform iOS`; iPhone 17 sims available),
so the rewrite now both **compiles and runs** on a simulator. All `swift`/`xcodebuild`/`xcodegen`
invocations here need `dangerouslyDisableSandbox` (temp/DerivedData/CoreSimulator/SPM-manifest
`sandbox-exec` writes are outside the sandbox allowlist). Run one test via
`xcodebuild test-without-building -xctestrun <…>.xctestrun -destination 'platform=iOS
Simulator,id=<26.5-device-udid>' -only-testing:CtrlProxyUITests/HierarchyIntegrationTests` (never run
`testRunService` — it waits forever). **Pin the iOS 26.5 runtime, not 27.0-beta:** `name=iPhone 17`
alone is ambiguous (a device exists on both runtimes) and picks 27.0, where the fixture won't render
and xcodebuild _teardown_ hangs ~10 min. Use the 26.5 device UDID (`xcrun simctl list devices`), where
the loop passes cleanly in ~7 s.

Suggested order:

1. ✅ **Wire `CtrlProxyRewrite` into `project.yml` / XcodeGen** — done in 7A (additive
   `CtrlProxyRewriteUITests` target; regenerated `project.pbxproj` with pinned XcodeGen 2.46.0).
2. ✅ **Full iOS compile** — 7A green `build-for-testing` (one host-hidden error fixed); 7B cleared
   the ~149 iOS strict-concurrency warnings → warning-clean, matching the SPM bar; `testServiceStarts`
   runs green on the sim.
3. ✅ **Point the runner at the rewrite (7C, middle route).** Repurposed the `CtrlProxyUITests`
   XcodeGen target to compile `Sources/CtrlProxyRewrite` (name/app/xctest/`-only-testing` identifier
   kept → zero TS/script churn). Reference impl kept as the SwiftPM parity oracle.
4. ✅ **(7D) On-device validation.** `testServiceStarts` green on iPhone 17; the full
   observe→gesture→hierarchy loop (`HierarchyIntegrationTests`) green on the **iOS 26.5** sim (not the
   27.0-beta — see the Phase-7D note). Still to fold in (nice-to-have): the deferred Phase-2 loopback
   smoke test + connection scenarios (§8) as iOS UI tests; a full `manual-test` live-client pass.
5. **(7E) Retire the reference — the one-way step; gate cleared, HYBRID disposition chosen.** A single
   cohesive change (the ordering constraint — the reference can't be dropped until every KEEP domain is
   decoupled from `Reference*` — makes partial steps low-value). **Inventory:** `CtrlProxyRewriteTests`
   = 17 `Reference*.swift` (`import CtrlProxy`) + 17 `Rewrite*.swift` + `*ParityTests` diffing them
   (~80 differential tests) + ~155 rewrite-only tests (survive untouched). Hybrid plan (Paul):
   - **Golden-re-anchor (KEEP), wire-contract / Codable domains** → assert `Rewrite*` output against a
     golden captured from the _current_ rewrite (valid: parity is green, so rewrite output == reference
     output == frozen-contract output): **WireDecode** (already fixture-anchored — just drop the
     reference-comparison half; the `assertWireSubset` vs `ios-ctrlproxy-request-snapshots.json` IS the
     golden), **ResponseModel**, **SdkDatabaseModel**, **HierarchyModel**, **PerformanceWire**. Small
     Codable outputs → literal/expected-JSON goldens (capture via a one-shot print-harvest). **Framing**
     (11, byte-loop) + **Geometry** (5): literal byte goldens are impractical → use a generated
     `#filePath`-relative golden fixture file (the same load technique `WireSnapshotFixture` already
     uses — no SPM resource decl needed), or reduce to representative cases + invariants.
   - **Delete (behavioral/driver)**: CommandHandler, Connection, HierarchyDebouncer, PerfProvider,
     VoiceOver, OSLog, FrameContext, SdkHierarchyExtractor, StorageInspecting, HierarchyMerge (the last
     also conflicts with the planned Phase-8 merger behavior change). Delete their `Reference*` +
     `Rewrite*` helpers + fixtures/recorders too (the compiler flags orphans).
   - **Then remove the reference**: drop `Sources/CtrlProxy` + `Tests/CtrlProxyTests`; the SwiftPM
     `CtrlProxy` target/product + `CtrlProxyTests`; `CtrlProxyRewriteTests`' `CtrlProxy` dependency +
     the per-target `.v5` modes; the Xcode `CtrlProxy` framework + `CtrlProxyTests` targets +
     `CtrlProxyApp`'s `CtrlProxy` embed + the scheme's `CtrlProxyTests`; and the `CtrlProxyTests.xctest`
     artifact checks in `scripts/ios/ctrl-proxy-{build-for-testing,verify-artifacts,create-ipa}.sh`.
   - **Validate**: SPM `-warnings-as-errors` (surviving rewrite-only + golden tests green) + a
     `build-for-testing` on the sim. Then fold in the deferred Phase-2 loopback/connection scenarios.
     Deliberately last and irreversible-ish (git keeps the deleted differential tests in history).
6. **Then Phase 8 fixups** (README index): the `os_signpost`/direct-interval PerfProvider
   simplification, the `HierarchyMerger` geometry-key improvement, the keyboard-focus RunLoop
   de-blocking — all off the critical path, validated against golden-replay corpora.

Design commitments from Phase 6 (do not re-litigate — see §6): `CommandHandler` is a `Sendable`
POD router (#5374); `handle` is `async -> any WebSocketResponsePayload`; command dispatch is a
serial `Task`-chain; `performContextCheckedGesture` is one `MainActor.run` turn inside a fresh
`perf.withScope`; the coordinator is `@MainActor` with a late-bound weak box for its immutable
`@Sendable` server seams.

## 10. Conventions

- **One type per file** (except very closely related types, e.g. algorithm-internal
  helpers nested with their owner, or a shape + its sub-shapes). See memory
  `one-type-per-file`.
- **Parity first.** Facially-suboptimal-but-not-concurrency things get a **planning note
  in the README fixup index + Phase 8**, not an inline change (keeps the migration
  behavior-preserving). Only the approved `HierarchyMerger` geometry-key improvement is
  slated to intentionally change behavior — and only post-critical-path, validated
  against a golden-replay corpus.
- Commits: conventional-commit style; co-author trailer
  `Co-Authored-By: Claude <svc-devxp-claude@slack-corp.com>` (per Paul's global config).
- Use `git -C <repo-root> …` for git so the shell cwd stays in the package.
- After a green sub-step, commit; keep the parity gate at 100%.

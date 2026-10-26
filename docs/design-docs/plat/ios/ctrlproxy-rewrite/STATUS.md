# CtrlProxy Swift-6 rewrite — status

See [README.md](README.md) for the fixup index. The rewrite is **complete**: it is the
sole `CtrlProxy` implementation (the product/target was later renamed from
`CtrlProxyRewrite`; names below keep the original), the reference oracle and the
differential-parity harness are removed, and the production XCUITest runner compiles
and runs the rewrite.

## Current state

- A parallel reimplementation of `ios/control-proxy` for Swift 6 strict concurrency,
  built and verified by differential parity against the old code, then cut over. Goals:
  idiomatic concurrency, and closing the real races behind production iOS flakiness.
- The **wire protocol is frozen** (the TS MCP server in `src/` speaks it); byte/shape
  parity was the hard contract, internals were free. Wire-contract tests now anchor on
  `test/fixtures/ios-ctrlproxy-request-snapshots.json` and a reference-free `JSONGolden`
  helper (decode→sorted-encode is idempotent and preserves every input wire field).
- Package: `Package.swift` tools 6.3, iOS 17 / macOS 15, all targets `.swiftLanguageMode(.v6)`.
  XcodeGen's `CtrlProxyUITests` target compiles the sources directly (Swift 6, strict
  concurrency `complete`, iOS 17). Fakes live in `CtrlProxyTestSupport`, not the shipped product.
- The server runs inside the XCUITest runner; the target, runner app, xctest bundle and
  `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService` identifier were kept
  across the cutover so the TS layer (`IOSCtrlProxyManager`, `IosCtrlProxyBuilder`,
  `IosCtrlProxyProcessClient`, process-recovery command-shape matchers) and
  `scripts/ios/ctrl-proxy-*.sh` needed no change.

## Build and gate

```bash
cd ios/control-proxy        # or pass --package-path; from the repo root `swift test`
                            # resolves a different package (ios/auto-mobile-sdk)
swift build -Xswiftc -warnings-as-errors
swift test  -Xswiftc -warnings-as-errors
```

CI runs `scripts/ios/swift-test.sh` (the same `-warnings-as-errors` invocation), which is the real
gate. The host build never compiles the iOS-only `@MainActor`/XCUITest bodies (they sit
behind `#if canImport(XCTest) && os(iOS)`), and Xcode keeps SDK-inferred main-actor
violations non-promotable even with `SWIFT_TREAT_WARNINGS_AS_ERRORS`, so iOS strict-concurrency
warnings are only caught by an iOS-simulator `build-for-testing`.

**Runtime caveat:** validate on the iOS **26.5** simulator runtime, not the 27.0 beta. On the
beta the host app never reaches its fixture view controller (XCUITest "Unable to monitor
event loop") and xcodebuild teardown hangs ~10 min. `name=iPhone 17` is ambiguous across
runtimes, so pin the 26.5 device UDID (`xcrun simctl list devices`). Run a single on-device test with
`xcodebuild test-without-building -xctestrun <...>.xctestrun -destination 'platform=iOS Simulator,id=<udid>' -only-testing:CtrlProxyUITests/HierarchyIntegrationTests`;
never run `testRunService` (it waits forever). `HierarchyIntegrationTests` is
`XCTSkipUnless`-guarded on the fixture appearing, so it skips rather than fails on the beta.

## Archetypes and load-bearing decisions

- **iOS 17 floor rules out `Synchronization.Mutex`** (iOS 18). Use actors,
  `OSAllocatedUnfairLock` (iOS 16+), or GCD queue-confinement.
- **Queue-confinement**: `final class ... @unchecked Sendable` + private serial
  `DispatchQueue` + `dispatchPrecondition(.onQueue(queue))`; public API funnels through
  `queue.sync`/`async`. Used by `WebSocketServer`, `WebSocketConnection`, `NWByteChannel`,
  `OSLogReader` (the last must be queue-confined: `OSLogStore` is not `Sendable`, so it cannot
  live in an `OSAllocatedUnfairLock<State: Sendable>`).
- **Lock-confined `Sendable`** (`OSAllocatedUnfairLock<State>`, no `@unchecked`) where a
  synchronous cross-thread path cannot `await`: `SdkEventBuffer`, `ConnectionRegistry`, the
  server's upgraded-client set, `SdkHierarchyCache`, `FrameContext`, `RotationChangeMonitor`,
  `PerfProvider`'s pool.
- **`SdkHierarchyCache` is a lock, not an actor.** Its write path (`POST /sdk-events` →
  `SdkHierarchyExtractor` → `update` → refresh broadcast) runs synchronously and in order on the
  connection's serial queue. An actor is reachable from that closure only via a detached `Task`,
  which would reorder cache updates across rapid POSTs (caching a stale hierarchy) and move JSON
  decode off the serial queue. A single-`withLock` transactional `reconcile` (read→compare→clear)
  closes the lost-update race instead.
- **`CommandHandler` is a `Sendable` POD router, not `@MainActor`**, or its blocking SDK HTTP/DB
  calls would freeze XCUITest and starve `/health` (#5374). `handle` is `async -> any
WebSocketResponsePayload` (`Sendable & Encodable`); it `await`s the `@MainActor` UI collaborators
  and async SDK clients and calls lock-confined ones synchronously. `encodeResponse` keeps the
  `WebSocketResponse`/`HierarchyUpdateResponse` downcasts for `perfTiming` injection.
- **Command dispatch is a serial `Task` chain**: `commandTail` (an
  `OSAllocatedUnfairLock<Task<Void, Never>?>`) and `await previous?.value` preserve per-command
  ordering (#5374) without a blocking queue hop and free the accept queue immediately.
  `WebSocketServer.handleMessage` brackets decode→handle→flush→encode in `perf.withScope`.
- **Coders are fresh-per-call** (`.sortedKeys`), removing the shared mutable `JSONEncoder`.
- **`ObjCExceptionCatcher` survives**: Swift still cannot catch XCUITest `NSException`s; the guard
  (`catchingObjCException`) sits inside the `@MainActor` body.
- **Perf call tree is a `@TaskLocal`, not thread-local.** The reference kept the open-entry stack
  per thread so an operation never nested under an in-flight one on another thread (#3635). With
  `@MainActor` `ElementLocator`, one hierarchy request spans the command queue and the main actor
  within one task, so a thread-local would split the tree at that hop. A `@TaskLocal` bound per
  operation by `withScope` propagates across the `await`; outside a scope the calls are safe
  no-ops. The scope is `@unchecked Sendable`, justified by single-task-serial mutation.
  Completed roots are snapshotted to immutable `PerfTiming` before entering the pool, and `flush()`
  drains the whole pool so command and polling timings report together. Injected `any
PerfTracking`; the coordinator owns the one instance (no singleton).
- **`performContextCheckedGesture` = one `MainActor.run` turn inside a FRESH `perf.withScope`.**
  Frame-context validation and the gesture run in one turn (atomic, no suspension between the
  generation read and the gesture). The reference's thread-local perf split a gesture-nested
  `track` (`setText.byResourceId`, `pressButton`, ...) onto the main thread's empty stack as its
  own root under a synthetic `total`; a plain `MainActor.run` would nest it under the handler, a
  different on-wire tree. The fresh scope reproduces the split (a trackless gesture leaves it
  empty).
- **`CtrlProxy` coordinator is `@MainActor`.** It owns the single instances and injects the
  server's immutable `@Sendable` seams at construction (`onSdkEventBatch`, `drainLogEvents`,
  `onClientPresenceChanged` for client-gated samplers, #5477). Those closures are built before
  `self` exists and fire off the main actor, so they capture a `WeakCoordinator`
  (`@unchecked Sendable`, written once during `init`, read only inside `Task { @MainActor }`).
- `XCUIDeviceRotationSampler` and `DeviceOrientationChangeSignal` reach main-actor UIKit/XCUITest
  state from host-compiled nonisolated protocols via `MainActor.assumeIsolated` (call-graph
  provably main; the signal's `deinit` is unreachable, a process-lifetime `static let`).
  `VoiceOverToggling.setVoiceOver` is `@MainActor`. The runner has no `tearDownWithError`
  override (it trips region isolation); each test stops its service via `defer`.
- `ElementLocator`'s iOS `init(application:perf:)` is `internal`: a `public` init cannot expose the
  internal `PerfTracking`, an error the host `#else` stub hides.

## Race ledger (all closed)

| Race                                                                   | Closed by                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `WebSocketServer.listener` unsynchronized (self-stop vs external stop) | queue-confinement                                                                    |
| `onClientPresenceChanged` torn closure                                 | immutable init-injected `@Sendable`                                                  |
| `SdkHierarchyCache` lost-update / dropped-event TOCTOU                 | lock-confined + transactional `reconcile`                                            |
| `getViewHierarchy` non-atomic multi-hop capture                        | `@MainActor` single transaction + rotation-capture epoch (race-free A→B→A detection) |
| `OSLogReader` overlap (concurrent polls, fresh store per poll)         | serial-queue confinement + single reused `OSLogStore`                                |
| DisplayLink orphan                                                     | `@MainActor` monitor owns the `CADisplayLink` lifecycle                              |
| `FrameContext` shared encoder                                          | lock-confined `Sendable` + fresh-per-call coder                                      |
| Perf call-tree mis-nest / cross-scope `end()` pop (#3635)              | `@TaskLocal` bound per operation by `withScope`                                      |

## Open items

- Phase 8 post-concurrency fixups: see the README index. The only intentional behavior change
  still pending is the `HierarchyMerger` geometry-key improvement
  ([fixup note](fixup-hierarchy-merger-geometry.md)), validated against a golden-replay corpus
  ([golden-replay.md](golden-replay.md)).
- The Phase-2 loopback smoke test (`127.0.0.1`) and extra connection scenarios
  (frames/ping/close/fragmentation/HTTP, scripted-`ByteChannel` harness) are still deferred as
  iOS UI tests, as is a full `manual-test` live-client pass.
- Known pre-existing flake: `WebSocketServerTests.testFragmentedCommandReassemblesEndToEnd`
  (`RealSocketClient` loopback timing); passes in isolation.

## Conventions

- One type per file (except tightly related helpers or a shape + its sub-shapes).
- Parity first: facially suboptimal but non-concurrency things get a README fixup note, not an
  inline change.

# CtrlProxy Swift-6 rewrite — status

`CtrlProxy` is the only implementation of `ios/control-proxy` and runs under Swift 6 strict
concurrency. See [README.md](README.md) for runner structure and diagnostics.

## Current state

- The **wire protocol is frozen**: the TypeScript MCP server in `src/` speaks it, so byte/shape
  parity is the contract and internals are free. Wire-contract tests anchor on
  `test/fixtures/ios-ctrlproxy-request-snapshots.json` and a reference-free `JSONGolden` helper
  (decode→sorted-encode is idempotent and preserves every input wire field).
- Package: `Package.swift` tools 6.3, iOS 17 / macOS 15, all targets `.swiftLanguageMode(.v6)`.
  XcodeGen's `CtrlProxyUITests` target compiles the sources directly (Swift 6, strict concurrency
  `complete`, iOS 17). Fakes live in `CtrlProxyTestSupport`, not the shipped product.
- The server runs inside the XCUITest runner. The TS layer (`IOSCtrlProxyManager`,
  `IosCtrlProxyBuilder`, `IosCtrlProxyProcessClient`, process-recovery command-shape matchers) and
  `scripts/ios/ctrl-proxy-*.sh` depend on the target, runner app, xctest bundle and
  `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService` identifier.
- Known flake: `WebSocketServerTests.testFragmentedCommandReassemblesEndToEnd` (`RealSocketClient`
  loopback timing); passes in isolation.
- Not covered by tests: a Phase-2 loopback smoke test (`127.0.0.1`), extra connection scenarios
  (frames/ping/close/fragmentation/HTTP, scripted-`ByteChannel` harness) as iOS UI tests, and a full
  `manual-test` live-client pass.

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

## Concurrency archetypes

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
- **Perf call tree is a `@TaskLocal`, not thread-local**, so an operation never nests under an
  in-flight one on another thread (#3635). With `@MainActor` `ElementLocator`, one hierarchy request
  spans the command queue and the main actor within one task, so a thread-local would split the tree
  at that hop. A `@TaskLocal` bound per
  operation by `withScope` propagates across the `await`; outside a scope the calls are safe
  no-ops. The scope is `@unchecked Sendable`, justified by single-task-serial mutation.
  Completed roots are snapshotted to immutable `PerfTiming` before entering the pool, and `flush()`
  drains the whole pool so command and polling timings report together. Injected `any
  PerfTracking`; the coordinator owns the one instance (no singleton).
- **`performContextCheckedGesture` = one `MainActor.run` turn inside a FRESH `perf.withScope`.**
  Frame-context validation and the gesture run in one turn (atomic, no suspension between the
  generation read and the gesture). The fresh scope makes a gesture-nested `track`
  (`setText.byResourceId`, `pressButton`, ...) its own root under a synthetic `total`, which is the
  on-wire tree shape; a plain `MainActor.run` would nest it under the handler. A trackless gesture
  leaves the scope empty.
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

## Conventions

- One type per file (except tightly related helpers or a shape + its sub-shapes).

## Background

- [CtrlProxy Swift 6 rewrite status and race ledger](../../../../devlog/2026-09-09-status-ctrlproxy-swift6-rewrite.md)

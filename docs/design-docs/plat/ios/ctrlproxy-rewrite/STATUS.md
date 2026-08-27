# CtrlProxy Swift-6 rewrite — status & resume guide

**This is the authoritative "where we are / how to continue" doc.** A fresh session
can be given minimal guidance — e.g. *"we just finished Phase 2; read
`docs/design-docs/plat/ios/ctrlproxy-rewrite/STATUS.md` and proceed into Phase 3"* —
and orient entirely from here. See [README.md](README.md) for the fixup-note index
and the amended phase plan.

Last updated after commit `2b1373016` (Phase 4 `@MainActor` UI domain complete).

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
fails it). Current: **216 rewrite tests, all green; full package 533 (reference) + 216
(rewrite) green.** (There is a known pre-existing flake in the reference suite —
`WebSocketServerTests.testFragmentedCommandReassemblesEndToEnd`, a `RealSocketClient`
loopback timing flake — unrelated to the rewrite; passes in isolation.)

**cwd hazard (bit us again in Phase 4):** run `swift` with an explicit
`--package-path ios/control-proxy` (or `cd` in first). From the repo root, `swift test`
resolves a *different* package (e.g. `ios/auto-mobile-sdk`, which has its own unrelated
pre-existing Swift-6 `URLProtocol: Sendable` error) and the failure looks like a rewrite
regression when it is not.

## 3. Package layout & per-target language modes

`Package.swift` (tools 6.3, platforms iOS 17 / macOS 15) uses **per-target language
modes** so the oracle keeps building while the rewrite is strict:

- `CtrlProxy` (reference oracle) + `CtrlProxyTests` → `.swiftLanguageMode(.v5)`.
  **Left pristine at `main`** — do not modify. (Paul's earlier incremental-fixup edits
  were reverted; saved at `scratch/reference-incremental-fixup-wip.patch`.)
- `CtrlProxyRewrite` + `CtrlProxyTestSupport` + `CtrlProxyRewriteTests` → `.v6`.
- `CtrlProxyRewrite` is at `Sources/CtrlProxyRewrite/` (155 `.swift` files); tests at
  `Tests/CtrlProxyRewriteTests/` (65 files).
- NOT yet in `project.yml` / XcodeGen (SPM-only) — wire into the Xcode/UI-test build at
  cutover (Phase 7). Fakes live in `CtrlProxyTestSupport` (not the shipped product).

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

| Phase | What | Commit(s) | State |
|---|---|---|---|
| 0 | Scaffold targets + Models (request half) + no-op `CtrlProxy` + decode-parity gate | `50579ab03` | ✅ |
| 1 | Pure/stateless core | `8aba998ca` `e683e6453` `e7589dd40` `499da2805` | ✅ |
| 2 | Networking core (queue-confinement) | `0a56900dc` `004e54279` `bae5cadaa` `84430e00d` | ✅ core |
| 3 | Off-main SDK layer (cache lock-confined + transactional; SDK/DB clients async; OSLogReader) | `f705e31ca` `d291db66c` `54ec41e39` `8ba273873` `1d8c08ba1` (+ de-flake `be92b2628`) | ✅ |
| 4 | `@MainActor` UI (ElementLocator, GesturePerformer, HierarchyDebouncer, DisplayLinkFPSMonitor, VoiceOver) | `a0646e713` `f715fc90a` `8c634c77a` `957916c1f` `400a3a42e` `d209ad95c` `e1f4c4d86` `2b1373016` | ✅ |
| 5 | PerfProvider (TaskLocal call-tree + confined pool) | — | ◻️ **NEXT** |
| 6 | CommandHandler (Sendable POD router, `handle` async) + `CtrlProxy` coordinator | — | ◻️ |
| 7 | Cutover (point runner/app at rewrite; retire reference; XcodeGen) | — | ◻️ |
| 8 | Post-concurrency fixups (see README index) | — | ◻️ |

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
  a *new* ordering hazard, the opposite of this rewrite's goal. A lock-confined cache keeps
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
  catch XCUITest `NSException`s; it just moves *inside* the `@MainActor` block.

## 7. Race ledger

| # | Race | Closed by | State |
|---|---|---|---|
| 3 | `WebSocketServer.listener` unsynchronized (self-stop vs external stop) | queue-confinement | ✅ (Phase 2) |
| 4 | `onClientPresenceChanged` torn closure | immutable init-injected `@Sendable` | ✅ (Phase 2) |
| 2 | `SdkHierarchyCache` lost-update / dropped-event TOCTOU | lock-confined + transactional `reconcile` (read→compare→clear in one `withLock`) | ✅ (Phase 3) |
| 1 | `getViewHierarchy` non-atomic multi-hop capture | `@MainActor` single-transaction (+ the rotation-capture epoch, race-free A→B→A detection) | ✅ (Phase 4F) |
| — | OSLogReader overlap (concurrent polls on a global queue; fresh store per poll) | serial-queue confinement + single reused `OSLogStore` | ✅ (Phase 3) |
| — | DisplayLink orphan | `@MainActor` monitor owns the `CADisplayLink` lifecycle | ✅ (Phase 4E) |
| — | FrameContext shared encoder | lock-confined `Sendable` + fresh-per-call coder | ✅ (Phase 4B) |

## 8. Seams left open (to fill in later phases)

- `WebSocketConnection` init hooks — the Phase-3 closures now EXIST and are exercised
  end-to-end in `ConnectionSdkSeamTests` (driver accepts them); only the **production**
  wiring is deferred to the Phase-6 coordinator:
  - `onSdkEventBatch: (@Sendable (Data) -> Void)?` → `{ SdkHierarchyExtractor.extractIfPresent(from:$0, into: cache, onHierarchyUpdated:) }`.
  - `drainLogEvents: (@Sendable () -> [Data])?` → `OSLogReaderHolder.shared.drain`.
- `WebSocketServer` seams: `CommandHandling` (Phase 6) and `PerfTracking` (Phase 5) remain
  open; `FrameContextRecording` is **implemented** (Phase 4B). All are wired to the
  concrete collaborators by the `CtrlProxy` coordinator in Phase 6.
- **Deferred to Phase 6 (CommandHandler):** `WebSocketResponsePayload` conformance for the
  Phase-3 DB response envelopes (+ the other handler-built envelopes) — the structs are
  `Codable & Sendable` now; the marker conformances land with the router batch.
- `broadcastPerformanceUpdate` (deferred from Phase 2, needed `PerformanceSnapshot`) is
  **done** — it landed with `DisplayLinkFPSMonitor` in Phase 4E. Still deferred from Phase 2:
  a `127.0.0.1` loopback smoke test; more connection scenarios
  (frames/ping/close/fragmentation/HTTP) on the existing scripted-`ByteChannel` harness
  (`ReferenceConnectionDriver` / `RewriteConnectionDriver` / `ConnectionRecorder`).

## 9. Phase 5 plan (NEXT) — PerfProvider

Read the reference first: `Sources/CtrlProxy/PerfProvider.swift` (~563 lines) and
`Sources/CtrlProxy/PerformanceMetrics.swift` (~213 lines). The time/timer seams this phase
builds on are **already ported** (Phase 4A): `TimeProvider.swift`, `SystemTimeProvider.swift`,
`ProxyTimer.swift` (the `Timer`→`ProxyTimer` rename from the README fixup index is **done**),
`SystemTimer.swift`, and the `PerfTracking.swift` protocol seam. So Phase 5 is the concrete
`PerfProvider` engine plus its metrics model.

What the reference does (and the concurrency smells to close):

1. **Singleton via `nonisolated(unsafe) static var _instance` + `NSLock`** — the manual
   double-checked-lock idiom. Port to a lock-confined `Sendable` (the established archetype:
   `OSAllocatedUnfairLock<State>`, no `@unchecked`), or reconsider the singleton entirely
   since Phase 6's `CommandHandler` can hold an injected instance.
2. **Shared completed-entry pool + debounce counters** (`completedEntries: [MutablePerfEntry]`,
   `debounceCount`, `lastDebounceTime`) guarded by one `NSLock`. `flush()` drains the whole
   pool so command-handling and background-polling timings report together — this pooled-flush
   behavior is **relied on** and must be preserved. Fold into the lock-confined state.
3. **Per-thread active-entry state — the load-bearing design decision.** The reference keeps
   the active-entry stack + current root in `Thread.current.threadDictionary` (`PerfLocalState`),
   **not** task-local, deliberately: operations on one thread (background hierarchy polling on
   the main thread) must not nest under an in-flight operation on another (command handling on
   the server queue). A single shared stack mis-nested the tree and let `end()` pop another
   thread's entry (#3635). **The amended plan's "TaskLocal call-tree" label conflicts with this**
   — `@TaskLocal` is per-*task*, inherited by child tasks, and does not map 1:1 onto the
   reference's per-*thread* isolation. Resolve this before porting: either (a) keep
   thread-local semantics (a `ThreadLocal`-style seam) and match the tree shape exactly, or
   (b) move to `@TaskLocal` only if the parity corpus proves the emitted timing tree is
   byte-identical across the polling-vs-command interleavings. Treat as an approval-worthy
   decision like the Phase-3 cache-lock call; record the outcome in §6.
4. **`MutablePerfEntry` is a mutable reference type** built into a tree, then serialized. The
   serialized shape (names, nesting, `isParallel`, durations) is the frozen wire surface —
   `PerformanceMetrics` / `PerfEntry` feed `perfTiming` on responses. Keep the emitted JSON
   byte-identical.
5. **Wire the open seams:** `WebSocketServer`'s `PerfTracking` seam (still open) binds to this
   port; `encodeResponse`'s `perfTiming` injection (already in the rewrite) consumes its
   `flush()`. Production wiring is the Phase-6 coordinator.
6. **Parity:** the `FakeTimeProvider` seam already exists, so drive deterministic start/end
   sequences through a fake clock and diff the flushed timing tree (reference vs rewrite) via
   the per-module-helper pattern — this is a *pure*, host-testable surface (no XCUITest), so it
   parity-tests fully on the macOS gate unlike the Phase-4 UI domain.

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

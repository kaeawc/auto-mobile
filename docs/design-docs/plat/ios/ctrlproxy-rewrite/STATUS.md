# CtrlProxy Swift-6 rewrite — status & resume guide

**This is the authoritative "where we are / how to continue" doc.** A fresh session
can be given minimal guidance — e.g. *"we just finished Phase 2; read
`docs/design-docs/plat/ios/ctrlproxy-rewrite/STATUS.md` and proceed into Phase 3"* —
and orient entirely from here. See [README.md](README.md) for the fixup-note index
and the amended phase plan.

Last updated after commit `84430e00d` (Phase 2 networking core complete).

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
fails it). Current: **42 tests, all green.** (There is a known pre-existing flake in the
reference suite — `WebSocketServerTests.testFragmentedCommandReassemblesEndToEnd`, a
`RealSocketClient` loopback timing flake — unrelated to the rewrite; passes in isolation.)

## 3. Package layout & per-target language modes

`Package.swift` (tools 6.3, platforms iOS 17 / macOS 15) uses **per-target language
modes** so the oracle keeps building while the rewrite is strict:

- `CtrlProxy` (reference oracle) + `CtrlProxyTests` → `.swiftLanguageMode(.v5)`.
  **Left pristine at `main`** — do not modify. (Paul's earlier incremental-fixup edits
  were reverted; saved at `scratch/reference-incremental-fixup-wip.patch`.)
- `CtrlProxyRewrite` + `CtrlProxyTestSupport` + `CtrlProxyRewriteTests` → `.v6`.
- `CtrlProxyRewrite` is at `Sources/CtrlProxyRewrite/` (90 files); tests at
  `Tests/CtrlProxyRewriteTests/` (25 files).
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
| 3 | Off-main SDK actors | — | ◻️ **NEXT** |
| 4 | `@MainActor` UI (ElementLocator, GesturePerformer, HierarchyDebouncer, DisplayLinkFPSMonitor, VoiceOver) | — | ◻️ |
| 5 | PerfProvider (TaskLocal call-tree + confined pool) | — | ◻️ |
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

## 6. Archetype map & load-bearing decisions

- **iOS 17 floor rules out `Synchronization.Mutex`** (needs iOS 18). Use actors,
  `OSAllocatedUnfairLock` (iOS 16+), or GCD queue-confinement.
- **Queue-confinement** = `final class … @unchecked Sendable` + private serial
  `DispatchQueue` + `dispatchPrecondition(.onQueue(queue))` on on-queue methods; public
  API funnels via `queue.sync`/`async`; the `@unchecked` is justified by that
  confinement, not a lock. (`WebSocketServer`, `WebSocketConnection`, `NWByteChannel`.)
- **Lock-confined Sendable collections** where a synchronous cross-thread snapshot is
  needed (broadcast can't `await`): `OSAllocatedUnfairLock<State>` → genuinely `Sendable`,
  no `@unchecked`. (`SdkEventBuffer`, `ConnectionRegistry`, and the server's
  upgraded-client set.)
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
| 2 | `SdkHierarchyCache` lost-update / dropped-event TOCTOU | actor + transactional `reconcile` | ◻️ **Phase 3** |
| 1 | `getViewHierarchy` non-atomic multi-hop capture | `@MainActor` single-transaction | ◻️ Phase 4 |
| — | DisplayLink orphan; OSLogReader overlap; FrameContext shared encoder | `@MainActor` / queue-confinement / stateless-func | ◻️ Phase 4/5 |

## 8. Seams left open (to fill in later phases)

- `WebSocketConnection` init hooks (Phase 2, currently nil in the server wiring):
  - `onSdkEventBatch: (@Sendable (Data) -> Void)?` → Phase 3 wires to
    `SdkHierarchyExtractor.extractIfPresent(into: cache, onHierarchyUpdated:)`.
  - `drainLogEvents: (@Sendable () -> [Data])?` → Phase 3 wires to `OSLogReaderHolder.shared.drain()`.
- `WebSocketServer` seams: `CommandHandling` (Phase 6), `PerfTracking` (Phase 5),
  `FrameContextRecording` (Phase 4). Wired by the `CtrlProxy` coordinator in Phase 6.
- Deferred within Phase 2: `broadcastPerformanceUpdate` (needs `PerformanceSnapshot`,
  Phase 4); a `127.0.0.1` loopback smoke test; more connection scenarios
  (frames/ping/close/fragmentation/HTTP) on the existing scripted-`ByteChannel` harness
  (`ReferenceConnectionDriver` / `RewriteConnectionDriver` / `ConnectionRecorder`).

## 9. Phase 3 plan (NEXT) — off-main SDK actors

Read the reference: `Sources/CtrlProxy/SdkHierarchyClient.swift`,
`SdkDatabaseClient.swift`, `SdkHierarchyCache.swift`, `SdkHierarchyModels.swift`,
`DefaultStorageInspecting.swift`, and `Protocols.swift` (the `SdkHierarchyFetching`,
`SdkHierarchyCaching`, `SdkDatabaseFetching`, `StorageInspecting` protocols).

1. **`SdkHierarchyCache` → `actor`** with a **transactional `reconcile`** method that
   does read → compare → clear/update as one isolated step. **This closes race #2**
   (the lost-update the reference's per-op `NSLock` can't prevent). Its callers in
   `CommandHandler` (Phase 6) become `await`.
2. **`SdkHierarchyClient` / `SdkDatabaseClient` → async** (actor or `Sendable` POD),
   replacing `DispatchSemaphore.wait` on `URLSession` with `data(for:)`.
3. Port the SDK **DB result models** (`SdkExecuteSqlResult`, `SdkTableDataResult`,
   `SdkTableStructureResult`, `SdkDatabaseInfo`, `SdkStorageCapabilities`, `SdkColumnInfo`,
   `SdkStorageDiagnostic`) + `SdkHierarchyServerInfo` + `SdkHierarchyExtractor` as
   `Sendable` PODs / stateless funcs, and the response envelopes that embed them
   (`ExecuteSqlResponse`, `ListDatabasesResponse`, etc.) — deferred from Phase 2.
4. `DefaultStorageInspecting` → `Sendable` (UserDefaults is thread-safe; its only mutable
   state `registeredSuites` has no production caller — don't over-isolate; a stateless
   Sendable wrapper is fine, per the analysis).
5. **Fill the connection's `onSdkEventBatch` / `drainLogEvents` seams.** `OSLogReader` +
   `OSLogReaderHolder` (queue-confinement) also land here (feeds `drainLogEvents`).
6. Parity: reuse the per-module-helper pattern (decode SDK payloads / run
   `SdkHierarchyExtractor` / diff cache reconcile outcomes); most SDK models are already
   `Sendable` in the reference so they port cleanly.

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

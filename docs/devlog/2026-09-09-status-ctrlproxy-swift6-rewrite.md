# CtrlProxy Swift 6 rewrite status and race ledger

- Kind: concept
- Date: 2026-09-09
- Source: moved from `how-it-works/plat/ios/ctrlproxy-rewrite/STATUS.md`; #5834, #3635, #5374,
  #5477, #5837
- Shaped: [CtrlProxy Swift-6 rewrite — status](../how-it-works/plat/ios/ctrlproxy-rewrite/STATUS.md)

## Outcome

The rewrite completed: it became the sole `CtrlProxy` implementation, the reference oracle and the
differential-parity harness were removed, and the production XCUITest runner compiles and runs it.
Goals were idiomatic concurrency and closing the real races behind production iOS flakiness. The
target, runner app, xctest bundle and `testRunService` identifier were kept across the cutover so the
TS layer and `scripts/ios/ctrl-proxy-*.sh` needed no change.

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

## Perf tree parity

The reference kept the perf open-entry stack per thread. Its thread-local perf split a gesture-nested
`track` onto the main thread's empty stack as its own root under a synthetic `total`; the rewrite's
fresh `perf.withScope` inside `performContextCheckedGesture` reproduces that on-wire tree.

## Conventions during the migration

Parity first: facially suboptimal but non-concurrency code got a fixup note instead of an inline
change. The last pending intentional behavior change was the `HierarchyMerger` geometry-key
improvement, since implemented and validated against a golden-replay corpus (#5837).

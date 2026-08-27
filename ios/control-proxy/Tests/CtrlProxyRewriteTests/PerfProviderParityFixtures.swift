import Foundation

// Shared, module-agnostic corpus for the PerfProvider parity harness. Imports NEITHER module,
// so `ReferencePerfProvider` (imports `CtrlProxy`) and `RewritePerfProvider` (imports
// `CtrlProxyRewrite`) can both interpret the same op sequence against their own provider and the
// diff in `PerfProviderParityTests` proves the flushed timing trees encode identically.
//
// A `PerfOp` is a single call against the provider's imperative API (plus `advance`, which steps
// the injected fake clock so durations are deterministic). Each `PerfScript` runs its ops and
// then a single terminal `flush()`, whose sorted-key-encoded bytes are compared across modules.

/// One driver-agnostic operation. `serial`/`parallel`/`start` differ only by the (unserialized)
/// `isParallel` flag; `end` closes the innermost open entry; `endOp` closes a named entry (a
/// mismatched name is a no-op); `advance` steps the fake clock; `recordDebounce` bumps the shared
/// debounce counter; `clear` wipes both the active scope and the shared pool.
enum PerfOp: Sendable {
    case serial(String)
    case parallel(String)
    case independentRoot(String)
    case start(String)
    case end
    case endOp(String)
    case advance(Int64)
    case recordDebounce
    case clear
}

struct PerfScript: Sendable {
    let name: String
    let ops: [PerfOp]
}

enum PerfProviderScripts {
    static let all: [PerfScript] = [
        PerfScript(name: "empty", ops: []),

        PerfScript(name: "single-serial", ops: [
            .serial("A"), .advance(5), .end,
        ]),

        PerfScript(name: "nested", ops: [
            .serial("A"), .advance(1),
            .serial("B"), .advance(2), .end,
            .advance(3), .end,
        ]),

        // Mirrors a real command: handleRequest > handleTap > tapElement (via track/startOperation).
        PerfScript(name: "command-shape", ops: [
            .serial("handleRequest:tap"), .advance(1),
            .serial("handleTap"), .advance(1),
            .start("tapElement"), .advance(4), .endOp("tapElement"),
            .advance(1), .end,
            .advance(1), .end,
        ]),

        // Two balanced roots drain together from the shared pool.
        PerfScript(name: "two-roots-pooled", ops: [
            .serial("A"), .advance(2), .end,
            .serial("B"), .advance(3), .end,
        ]),

        // independentRoot ends the open root, then starts a fresh sibling.
        PerfScript(name: "independent-root", ops: [
            .serial("A"), .advance(2),
            .independentRoot("B"), .advance(3), .end,
        ]),

        // independentRoot with a still-open nested child: A>B closes as one root, then C.
        PerfScript(name: "independent-root-nested-open", ops: [
            .serial("A"), .serial("B"), .advance(2),
            .independentRoot("C"), .advance(1), .end,
        ]),

        // independentRoot as the FIRST op: the "end all open entries" loop does nothing (empty
        // stack), it just starts a root.
        PerfScript(name: "independent-root-first", ops: [
            .independentRoot("A"), .advance(2), .end,
        ]),

        // parallel blocks encode identically to serial (isParallel never reaches the wire).
        PerfScript(name: "parallel-block", ops: [
            .serial("root"), .advance(1),
            .parallel("p1"), .advance(2), .end,
            .parallel("p2"), .advance(3), .end,
            .advance(1), .end,
        ]),

        // A mismatched endOperation name is ignored; the balanced ones close A>B.
        PerfScript(name: "endOp-mismatch", ops: [
            .start("A"), .start("B"),
            .endOp("WRONG"), .advance(5),
            .endOp("B"), .endOp("A"),
        ]),

        // flush() closes entries left open (B then A), timing them to flush-time.
        PerfScript(name: "flush-closes-incomplete", ops: [
            .serial("A"), .advance(2),
            .serial("B"), .advance(3),
        ]),

        PerfScript(name: "debounce-only", ops: [
            .recordDebounce, .advance(10), .recordDebounce,
        ]),

        // Debounce recorded WHILE a root is open on the scope, then the root continues and closes:
        // the debounce lives in the shared pool (scope-independent) and surfaces alongside the root.
        PerfScript(name: "debounce-while-root-open", ops: [
            .serial("A"), .recordDebounce, .advance(2), .end,
        ]),

        PerfScript(name: "root-plus-debounce", ops: [
            .serial("A"), .advance(4), .end,
            .recordDebounce,
        ]),

        // clear() wipes the prior pooled root + debounce; only B survives to flush.
        PerfScript(name: "clear-wipes-pool", ops: [
            .serial("A"), .advance(2), .end, .recordDebounce,
            .clear,
            .serial("B"), .advance(3), .end,
        ]),
    ]
}

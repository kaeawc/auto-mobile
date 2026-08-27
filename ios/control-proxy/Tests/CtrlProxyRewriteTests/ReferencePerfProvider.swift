import CtrlProxy
import Foundation

// REFERENCE side of the PerfProvider parity harness. Imports ONLY `CtrlProxy`, so
// `PerfProvider` / `PerfTiming` / `TimeProvider` resolve to the oracle's types. Interprets a
// module-agnostic `[PerfOp]` against a fresh oracle provider (thread-local call-tree), flushes,
// and returns the sorted-key-encoded bytes for the diff in `PerfProviderParityTests`.
enum ReferencePerfProvider {
    /// Manual clock conforming to the *oracle's* `TimeProvider`. Defined locally rather than
    /// reusing the oracle's public `FakeTimeProvider`: unqualified `FakeTimeProvider` would shadow
    /// to the test target's own (a `CtrlProxyRewrite.TimeProvider`, the wrong protocol) and the
    /// module-qualified `CtrlProxy.FakeTimeProvider` is ambiguous (module/type name collision,
    /// STATUS §4). Single-threaded synchronous use, so no lock is needed.
    private final class RefClock: TimeProvider {
        private var current: Int64 = 0
        func currentTimeMillis() -> Int64 { current }
        func advance(by milliseconds: Int64) { current += milliseconds }
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    /// Run `ops` (then a terminal `flush()`) against a fresh oracle provider and return the
    /// encoded flushed tree. A nil flush encodes to empty `Data` — the only empty case, since
    /// `flush()` returns nil rather than an empty array (so it stays distinguishable in the diff).
    static func run(_ ops: [PerfOp]) throws -> Data {
        let clock = RefClock()
        let provider = PerfProvider.createForTesting(timeProvider: clock)
        for op in ops {
            switch op {
            case let .serial(name): provider.serial(name)
            case let .parallel(name): provider.parallel(name)
            case let .independentRoot(name): provider.independentRoot(name)
            case let .start(name): provider.startOperation(name)
            case .end: provider.end()
            case let .endOp(name): provider.endOperation(name)
            case let .advance(ms): clock.advance(by: ms)
            case .recordDebounce: provider.recordDebounce()
            case .clear: provider.clear()
            }
        }
        guard let timings = provider.flush() else { return Data() }
        return try encoder().encode(timings)
    }
}

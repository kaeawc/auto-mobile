@testable import CtrlProxyRewrite
import Foundation

// REWRITE side of the PerfProvider parity harness. Imports ONLY `CtrlProxyRewrite`, so
// `PerfProvider` / `PerfTiming` resolve to the rewrite's types. Unlike the oracle (thread-local
// call-tree, always live), the rewrite's call-tree is a `@TaskLocal` bound by `withScope`, so the
// ops AND the terminal `flush()` run *inside* one `withScope` — the flush must see the scope to
// close entries left open. The reference's `FakeTimeProvider` seam is reused (same-module test
// helper). The diff in `PerfProviderParityTests` proves the flushed trees encode identically.
enum RewritePerfProvider {
    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    /// Run `ops` (then a terminal `flush()`) against a fresh provider inside one `withScope`, and
    /// return the encoded flushed tree. A nil flush encodes to empty `Data`, matching
    /// `ReferencePerfProvider.run`.
    static func run(_ ops: [PerfOp]) throws -> Data {
        let clock = FakeTimeProvider()
        let provider = PerfProvider(timeProvider: clock)
        return try provider.withScope {
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
}

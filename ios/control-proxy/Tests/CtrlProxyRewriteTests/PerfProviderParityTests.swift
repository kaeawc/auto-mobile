import Foundation
import XCTest

// Differential parity for PerfProvider. Imports NEITHER module: the per-module drivers
// (`ReferencePerfProvider` / `RewritePerfProvider`) each interpret the same `[PerfOp]` corpus
// against their own provider, flush, and return sorted-key-encoded bytes; this suite diffs them.
// A divergence in the flushed timing tree — nesting, names, durations, debounce, or the
// pooled-flush behavior — fails here. This is a pure, host-testable surface (no XCUITest), so it
// gates fully on the macOS `swift test` run.
final class PerfProviderParityTests: XCTestCase {
    func testFlushedTimingTreeEncodesIdenticallyAcrossModules() throws {
        for script in PerfProviderScripts.all {
            let reference = try ReferencePerfProvider.run(script.ops)
            let rewrite = try RewritePerfProvider.run(script.ops)
            XCTAssertEqual(
                reference, rewrite,
                "PerfProvider flushed-tree bytes diverge for script \"\(script.name)\"\n"
                    + "  reference: \(String(decoding: reference, as: UTF8.self))\n"
                    + "  rewrite:   \(String(decoding: rewrite, as: UTF8.self))"
            )
        }
    }

    /// Guards the corpus itself: at least one script must produce a non-empty flush, otherwise the
    /// parity test above would pass vacuously (every driver returning empty `Data`).
    func testCorpusProducesNonEmptyOutput() throws {
        let anyNonEmpty = try PerfProviderScripts.all.contains { !(try ReferencePerfProvider.run($0.ops).isEmpty) }
        XCTAssertTrue(anyNonEmpty, "PerfProvider parity corpus produced no timing data — the diff would be vacuous")
    }
}

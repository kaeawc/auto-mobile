@testable import CtrlProxyRewrite
import OSLog
import os
import XCTest

/// Parity + behavior for the rewrite's queue-confined `OSLogReader` (Phase 3). OSLog rows
/// are served on the SDK-events endpoint alongside SDK log events and share one numeric
/// level scale downstream, so `mapLevel` must agree with the reference exactly (issue
/// #4847). Also pins the store-reuse invariant (#5477) and the raised poll cadence.
final class OSLogReaderParityTests: XCTestCase {
    private let levels: [OSLogEntryLog.Level] = [.undefined, .debug, .info, .notice, .error, .fault]

    func testMapLevelMatchesReferenceForEveryLevel() {
        for level in levels {
            XCTAssertEqual(
                ReferenceOSLog.mapLevel(level),
                RewriteOSLog.mapLevel(level),
                "mapLevel diverged for \(level)"
            )
        }
        // Sanity: the SDK scale is emitted (not an Android-style one).
        XCTAssertEqual(RewriteOSLog.mapLevel(.debug), 1)
        XCTAssertEqual(RewriteOSLog.mapLevel(.error), 4)
        XCTAssertEqual(RewriteOSLog.mapLevel(.fault), 5)
    }

    func testPollIntervalMatchesReferenceAndIsAtLeastOneSecond() {
        XCTAssertEqual(RewriteOSLog.pollIntervalMs, ReferenceOSLog.pollIntervalMs)
        XCTAssertGreaterThanOrEqual(RewriteOSLog.pollIntervalMs, 1000)
    }

    /// The `OSLogStore` is created once and reused across polls, not allocated per tick.
    func testReusesSingleOSLogStore() throws {
        let creations = OSAllocatedUnfairLock<Int>(initialState: 0)
        let reader = OSLogReader(storeFactory: {
            creations.withLock { $0 += 1 }
            return try OSLogStore(scope: .currentProcessIdentifier)
        })

        let first: OSLogStore
        do {
            first = try reader.obtainStore()
        } catch {
            throw XCTSkip("OSLogStore is unavailable in this environment: \(error)")
        }
        let second = try reader.obtainStore()

        XCTAssertEqual(creations.withLock { $0 }, 1, "store should be created exactly once")
        XCTAssertTrue(first === second, "the same OSLogStore instance is reused across polls")
    }

    /// Draining an idle reader yields no batches (no empty `[{...}]` envelope).
    func testDrainEmptyReturnsNoBatches() {
        XCTAssertTrue(OSLogReader().drain().isEmpty)
    }
}

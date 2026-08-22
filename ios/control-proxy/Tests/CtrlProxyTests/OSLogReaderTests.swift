@testable import CtrlProxy
import OSLog
import XCTest

/// OSLog entries are served on the SDK-events endpoint alongside AutoMobile SDK log
/// events and share one numeric level scale downstream (the desktop Logs facet buckets
/// every iOS row on the SDK `LogLevel` scale). So `OSLogReader.mapLevel` must emit the
/// SDK scale (`verbose=0, debug=1, info=2, warning=3, error=4, fault=5`) — not an
/// Android-style one — or OSLog rows mis-bucket against SDK rows in the same stream
/// (issue #4847).
@available(iOS 15.0, macOS 12.0, *)
final class OSLogReaderTests: XCTestCase {
    func testMapsEachOSLogLevelToTheSdkScale() {
        XCTAssertEqual(OSLogReader.mapLevel(.debug), 1, "debug -> SDK debug (1)")
        XCTAssertEqual(OSLogReader.mapLevel(.info), 2, "info -> SDK info (2)")
        // OSLog has no warning severity; .notice is its default level, closest to info.
        XCTAssertEqual(OSLogReader.mapLevel(.notice), 2, "notice -> SDK info (2)")
        XCTAssertEqual(OSLogReader.mapLevel(.error), 4, "error -> SDK error (4)")
        XCTAssertEqual(OSLogReader.mapLevel(.fault), 5, "fault -> SDK fault (5)")
        // Unknown severities default to info rather than a high level, so an
        // unrecognized entry is never surfaced as an error.
        XCTAssertEqual(OSLogReader.mapLevel(.undefined), 2, "undefined -> SDK info (2)")
    }

    /// The desktop buckets an iOS row by folding its SDK-scale level through the same
    /// thresholds for both sources: 0->Verbose, 1->Debug, 2->Info, 3->Warn, 4/5->Error.
    /// These are the buckets an OSLog error and fault must land in once normalized, so an
    /// OSLog error and an SDK fault both read as Error in one stream.
    func testNormalizedLevelsLandInTheExpectedDesktopBuckets() {
        XCTAssertLessThanOrEqual(OSLogReader.mapLevel(.debug), 1) // Debug or below
        XCTAssertEqual(OSLogReader.mapLevel(.error), 4) // Error bucket (>=4)
        XCTAssertGreaterThanOrEqual(OSLogReader.mapLevel(.fault), 4) // Error bucket
    }

    // MARK: - Idle-load reductions (#5477)

    /// The poll interval was raised from 500ms to at least 1s so the idle process
    /// log store is queried at most once per second.
    func testPollIntervalIsAtLeastOneSecond() {
        XCTAssertGreaterThanOrEqual(OSLogReader.pollIntervalMs, 1000)
    }

    /// The `OSLogStore` is created once and reused across polls, rather than
    /// allocated on every tick as before.
    func testReusesSingleOSLogStore() throws {
        var creations = 0
        let reader = OSLogReader(storeFactory: {
            creations += 1
            return try OSLogStore(scope: .currentProcessIdentifier)
        })

        let first: OSLogStore
        do {
            first = try reader.obtainStore()
        } catch {
            throw XCTSkip("OSLogStore is unavailable in this environment: \(error)")
        }
        let second = try reader.obtainStore()

        XCTAssertEqual(creations, 1, "store should be created exactly once")
        XCTAssertTrue(first === second, "the same OSLogStore instance is reused across polls")
    }
}

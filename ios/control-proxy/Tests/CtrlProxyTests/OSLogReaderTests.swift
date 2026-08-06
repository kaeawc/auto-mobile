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
}

import Foundation
@testable import XCTestRunner
import XCTest

final class XCTestObservationIntegrationTests: XCTestCase {
    private static func timing(_ name: String, duration: TimeInterval = 1, passed: Bool = true) -> AutoMobileTestObserver.TimingData {
        let start = Date(timeIntervalSince1970: 0)
        return AutoMobileTestObserver.TimingData(
            testName: name,
            duration: duration,
            startTime: start,
            endTime: start.addingTimeInterval(duration),
            passed: passed
        )
    }

    func testRecordAndGetTimingData() {
        let observer = AutoMobileTestObserver()
        observer.recordTiming(Self.timing("a"))
        observer.recordTiming(Self.timing("b"))
        let data = observer.getTimingData()
        XCTAssertEqual(data.map(\.testName), ["a", "b"])
    }

    func testExportTimingDataWritesJSONArray() throws {
        let observer = AutoMobileTestObserver()
        observer.recordTiming(Self.timing("a"))
        observer.recordTiming(Self.timing("b"))
        observer.recordTiming(Self.timing("c"))

        let path = NSTemporaryDirectory() + "am-timing-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: path) }
        try observer.exportTimingData(to: path)

        let raw = try Data(contentsOf: URL(fileURLWithPath: path))
        let array = try JSONSerialization.jsonObject(with: raw) as? [[String: Any]]
        XCTAssertEqual(array?.count, 3)
    }

    /// Concurrent appends and snapshot reads must not race. exportTimingData and
    /// printSummary previously read `timingData` without the lock while
    /// testCaseDidFinish appended under it (issue #3629). Both now go through the
    /// lock-guarded getTimingData() snapshot, exercised here via getTimingData().
    func testConcurrentRecordAndReadDoNotCrash() {
        let observer = AutoMobileTestObserver()

        DispatchQueue.concurrentPerform(iterations: 2_000) { i in
            observer.recordTiming(Self.timing("t\(i)"))
            _ = observer.getTimingData() // snapshot read concurrent with appends
        }

        XCTAssertEqual(observer.getTimingData().count, 2_000)
    }
}

import Foundation
import XCTest
@testable import XCTestRunnerRewrite

/// Phase-6: the XCTest-bound types (`nonisolated` + lock-confined). Verifies observer registration
/// idempotency, the locked timing-record snapshot, the frozen export-JSON shape (contract 5b), and the
/// base-class `defaultTestSuite` short-circuit (which the `nonisolated` override must preserve).
final class Phase6XCTestBoundTests: XCTestCase {
    func testObserverRegistrationIsIdempotent() {
        let first = AutoMobileTestObserver.registerIfNeeded()
        let second = AutoMobileTestObserver.registerIfNeeded()
        XCTAssertTrue(first === second, "registration is memoized behind the lock")
    }

    func testObserverRecordsTimingUnderLock() {
        let observer = AutoMobileTestObserver()
        observer.recordTiming(.init(testName: "a", duration: 1.0, startTime: Date(), endTime: Date(), passed: true))
        observer.recordTiming(.init(testName: "b", duration: 2.0, startTime: Date(), endTime: Date(), passed: false))
        let data = observer.getTimingData()
        XCTAssertEqual(data.count, 2)
        XCTAssertEqual(data.map { $0.testName }, ["a", "b"])
    }

    func testTimingDataEncodableShapeIsFrozen() throws {
        let timing = AutoMobileTestObserver.TimingData(
            testName: "MyTest",
            duration: 1.5,
            startTime: Date(timeIntervalSince1970: 0),
            endTime: Date(timeIntervalSince1970: 1.5),
            passed: true
        )
        let encoded = try JSONEncoder().encode([timing])
        let array = try XCTUnwrap(try JSONSerialization.jsonObject(with: encoded) as? [[String: Any]])
        let object = try XCTUnwrap(array.first)
        XCTAssertEqual(Set(object.keys), ["testName", "duration", "startTime", "endTime", "passed"])
        XCTAssertEqual(object["testName"] as? String, "MyTest")
        XCTAssertEqual(object["passed"] as? Bool, true)
        XCTAssertEqual(object["duration"] as? Double, 1.5)
        XCTAssertTrue(object["startTime"] is String, "timestamps are ISO8601 strings")
        XCTAssertTrue(object["endTime"] is String)
    }

    func testBaseClassDefaultTestSuiteShortCircuitsToEmpty() {
        let suite = AutoMobileTestCase.defaultTestSuite
        XCTAssertEqual(suite.name, "AutoMobileTestCase")
        XCTAssertTrue(suite.tests.isEmpty, "the base class returns an empty suite before any timing/observer work")
    }
}

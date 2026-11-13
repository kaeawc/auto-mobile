@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeLoadReportTests: XCTestCase {
    func testRepeatedRefusalReportsFailureOncePerLoad() {
        var report = PrototypeLoadReport()
        report.begin()
        XCTAssertTrue(report.settle(.failed))
        XCTAssertFalse(report.settle(.failed))
        XCTAssertFalse(report.settle(.loaded))
        XCTAssertEqual(report.outcome, .failed)
    }

    func testRefusalAfterSuccessfulOpenIsNotReported() {
        var report = PrototypeLoadReport()
        report.begin()
        XCTAssertTrue(report.settle(.loaded))
        // Network toggled off, then on: the refusal and the restored renderer report nothing more.
        XCTAssertFalse(report.settle(.failed))
        XCTAssertFalse(report.settle(.loaded))
        XCTAssertEqual(report.outcome, .loaded)
    }

    func testNewLoadReportsAgain() {
        var report = PrototypeLoadReport()
        report.begin()
        XCTAssertTrue(report.settle(.failed))
        report.begin()
        XCTAssertNil(report.outcome)
        XCTAssertTrue(report.settle(.loaded))
    }
}

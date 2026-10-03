import Darwin
import XCTest
@testable import XCTestRunner

final class DaemonProcessLivenessTests: XCTestCase {
    func testInvalidProcessIdsAreNotRunning() {
        for pid in [0, -1, Int(Int32.max) + 1, Int.max, Int.min] {
            XCTAssertFalse(DaemonManager.isProcessRunning(pid: pid), "invalid pid \(pid)")
        }
    }

    func testCurrentProcessIsRunning() {
        XCTAssertTrue(DaemonManager.isProcessRunning(pid: Int(getpid())))
    }
}

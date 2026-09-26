import Foundation
@testable import ScreenCaptureHelper
import XCTest

final class PermissionHintTimerTests: XCTestCase {
    private final class Lines: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String] = []
        func append(_ line: String) { lock.withLock { values.append(line) } }
        func snapshot() -> [String] { lock.withLock { values } }
        func clear() { lock.withLock { values.removeAll() } }
    }

    func testHintEmitsOnlyBeforeFirstFrame() {
        let firstFrame = FirstFrameSignal()
        let lines = Lines()
        let hint = PermissionHintTimer(firstFrameSignal: firstFrame, approvalTarget: "Terminal") {
            lines.append($0)
        }

        hint.emitIfNeeded()
        XCTAssertEqual(lines.snapshot().count, 3)
        XCTAssertTrue(lines.snapshot()[2].hasPrefix("error: Screen Recording permission"))

        lines.clear()
        firstFrame.markReceivedFrame()
        hint.emitIfNeeded()
        XCTAssertTrue(lines.snapshot().isEmpty)
    }
}

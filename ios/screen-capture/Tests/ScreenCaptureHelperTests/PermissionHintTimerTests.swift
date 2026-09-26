import Foundation
@testable import ScreenCaptureHelper
import XCTest

final class PermissionHintTimerTests: XCTestCase {
    private final class FakeScheduler: @unchecked Sendable {
        private let lock = NSLock()
        private var handler: (@Sendable () -> Void)?

        func schedule(_: TimeInterval, _ action: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
            lock.withLock { handler = action }
            return { [weak self] in self?.lock.withLock { self?.handler = nil } }
        }

        func fire() {
            let action = lock.withLock { handler }
            DispatchQueue.global().sync { action?() }
        }
    }

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
        let scheduler = FakeScheduler()
        let hint = PermissionHintTimer(
            firstFrameSignal: firstFrame,
            approvalTarget: "Terminal",
            schedule: scheduler.schedule
        ) {
            lines.append($0)
        }

        hint.arm(after: 10)
        scheduler.fire()
        XCTAssertEqual(lines.snapshot().count, 3)
        XCTAssertTrue(lines.snapshot()[2].hasPrefix("error: Screen Recording permission"))

        lines.clear()
        firstFrame.markReceivedFrame()
        scheduler.fire()
        XCTAssertTrue(lines.snapshot().isEmpty)
        hint.stop()
    }
}

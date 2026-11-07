@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

@MainActor
final class PrototypeViewCommandsTests: XCTestCase {
    private final class Window: PrototypeEditingWindow {
        var forced: [Bool] = []
        func endEditing(_ force: Bool) -> Bool {
            forced.append(force)
            return true
        }
    }

    func testQueueHoldsCommandsUntilAWindowIsAttachedThenRunsOnce() {
        var queue = PrototypeViewCommandQueue()
        queue.run([.hideKeyboard], in: nil)
        XCTAssertFalse(queue.isEmpty)
        let window = Window()
        queue.run([], in: window)
        XCTAssertEqual(window.forced, [true])
        XCTAssertTrue(queue.isEmpty)
        queue.run([], in: window)
        XCTAssertEqual(window.forced, [true])
        queue.run([.hideKeyboard], in: window)
        XCTAssertEqual(window.forced, [true, true])
    }

    func testHideKeyboardActionEndsEditingOnThePrototypeWindowAndDrainsOnce() throws {
        let spec = try JSONDecoder().decode(
            PrototypeSpec.self,
            from: Data(
                #"{"id":"keyboard","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"hello"}}"#
                    .utf8
            )
        )
        let hide = try JSONDecoder().decode(PrototypeAction.self, from: Data(#"{"type":"hideKeyboard"}"#.utf8))
        var session = PrototypeSession()
        session.show(spec)
        let events = session.run([hide])
        XCTAssertTrue(events.isEmpty)
        let window = Window()
        PrototypeViewCommands.perform(session.takeViewCommands(), in: window)
        XCTAssertEqual(window.forced, [true])
        PrototypeViewCommands.perform(session.takeViewCommands(), in: window)
        XCTAssertEqual(window.forced, [true])
        _ = session.dismiss(reason: .user)
        _ = session.run([hide])
        XCTAssertTrue(session.takeViewCommands().isEmpty)
    }
}

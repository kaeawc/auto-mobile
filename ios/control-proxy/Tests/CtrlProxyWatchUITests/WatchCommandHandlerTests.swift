import AutoMobileSdkWire
import Foundation
import XCTest

@MainActor
final class WatchCommandHandlerTests: XCTestCase {
    func testCommandFailureCoordinatorScopesAndBoundsFailures() {
        let coordinator = WatchXCUISource.CommandFailureCoordinator()
        XCTAssertFalse(coordinator.recordDeflectedFailure("Outside gesture"))
        coordinator.begin()
        XCTAssertTrue(coordinator.recordDeflectedFailure("Tap failed"))
        XCTAssertTrue(coordinator.recordDeflectedFailure("Swipe failed"))
        XCTAssertEqual(coordinator.finish(), ["Tap failed", "Swipe failed"])
        XCTAssertFalse(coordinator.recordDeflectedFailure("After gesture"))
        XCTAssertEqual(coordinator.finish(), [])

        coordinator.begin()
        for _ in 0 ... WatchXCUISource.CommandFailureCoordinator.maxFailures {
            XCTAssertTrue(coordinator.recordDeflectedFailure("Failure"))
        }
        let failures = coordinator.finish()
        XCTAssertEqual(failures.count, WatchXCUISource.CommandFailureCoordinator.maxFailures + 1)
        XCTAssertEqual(failures.last, "Additional command failures truncated")

        coordinator.begin()
        XCTAssertTrue(coordinator.recordDeflectedFailure(String(repeating: "🐾", count: 4096)))
        let descriptions = coordinator.finish()
        XCTAssertLessThanOrEqual(
            descriptions.reduce(0) { $0 + $1.utf8.count },
            WatchXCUISource.CommandFailureCoordinator.maxDescriptionBytes
        )
        XCTAssertEqual(descriptions.last, "Additional command failures truncated")
        XCTAssertFalse(coordinator.recordDeflectedFailure("After truncated gesture"))
    }

    func testAllowlistContainsExactlyHierarchyTapAndSwipe() {
        XCTAssertEqual(WatchCommandHandler.supportedCommands, ["hierarchy", "tap", "swipe"])
    }

    func testEveryOtherCommandReturnsStructuredUnsupportedError() throws {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        for command in ["home", "crown", "screenshot", "unknown", "request_screenshot", "press_home", ""] {
            // Unsupported commands are rejected before their parameters are decoded.
            let request = Data("{\"type\":\"\(command)\",\"requestId\":\"r1\",\"x\":\"invalid\"}".utf8)
            let response = handler.handle(request)
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.type, "error")
            XCTAssertEqual(response.requestId, "r1")
            XCTAssertEqual(response.errorCode, "unsupported_on_watchos")
            XCTAssertEqual(response.error, "\(command) is unsupported on watchOS")
            let encoded = try JSONEncoder().encode(response)
            let decoded = try JSONDecoder().decode(WatchResponse.self, from: encoded)
            XCTAssertEqual(decoded.errorCode, response.errorCode)
            XCTAssertEqual(decoded.error, response.error)
        }
        XCTAssertEqual(source.calls, [])
    }

    func testHandshakeReportsWatchOSAndSupportedCommands() throws {
        let data = try JSONEncoder().encode(WatchConnectedEvent(id: 7))
        let event = try JSONDecoder().decode(WatchConnectedEvent.self, from: data)
        XCTAssertEqual(event.type, "connected")
        XCTAssertEqual(event.id, 7)
        XCTAssertEqual(event.platform, "watchos")
        XCTAssertEqual(event.supportedCommands, ["hierarchy", "tap", "swipe"])
        XCTAssertEqual(event.supportedFeatures, [])
    }

    func testSupportedCommandsUseInjectedSources() throws {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let hierarchy = handler.handle(Data(#"{"type":"hierarchy","requestId":"h"}"#.utf8))
        XCTAssertTrue(hierarchy.success)
        XCTAssertEqual(hierarchy.type, "hierarchy_update")
        XCTAssertEqual(hierarchy.requestId, "h")
        XCTAssertEqual(hierarchy.data?.root?.accessibilityLabel, "Counter")
        XCTAssertTrue(handler.handle(Data(#"{"type":"tap","x":12.5,"y":20}"#.utf8)).success)
        XCTAssertTrue(handler.handle(Data(#"{"type":"tap","identifier":"counter"}"#.utf8)).success)
        for direction in ["up", "down", "left", "right"] {
            XCTAssertTrue(handler.handle(Data("{\"type\":\"swipe\",\"direction\":\"\(direction)\"}".utf8)).success)
        }
        XCTAssertEqual(source.calls, ["hierarchy", "tap:12.5,20.0", "tap:counter", "up", "down", "left", "right"])
    }

    func testInvalidSupportedRequestsReturnErrorsWithoutGestures() {
        let source = FakeWatchSource()
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        for json in [
            #"{"type":"tap"}"#,
            #"{"type":"tap","x":1}"#,
            #"{"type":"swipe","direction":"diagonal"}"#,
            "{",
        ] {
            let response = handler.handle(Data(json.utf8))
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.errorCode, "invalid_request")
        }
        XCTAssertEqual(source.calls, [])
    }

    func testSourceFailureBecomesStructuredError() {
        let source = FakeWatchSource()
        source.shouldFail = true
        let handler = WatchCommandHandler(snapshotSource: source, gestures: source)
        let response = handler.handle(Data(#"{"type":"hierarchy","requestId":"h"}"#.utf8))
        XCTAssertFalse(response.success)
        XCTAssertEqual(response.requestId, "h")
        XCTAssertEqual(response.errorCode, "command_failed")
        XCTAssertEqual(response.error, "Snapshot failed")
    }
}

@MainActor
private final class FakeWatchSource: WatchSnapshotSource, WatchGesturePerformer {
    var calls: [String] = []
    var shouldFail = false

    func snapshot() throws -> SdkViewHierarchy {
        if shouldFail { throw WatchCommandError.commandFailed("Snapshot failed") }
        calls.append("hierarchy")
        return SdkViewHierarchy(
            timestamp: 0, screenScale: 1, screenWidth: 100, screenHeight: 100,
            root: SdkViewNode(
                className: "XCUIElementType(9)", bounds: SdkBounds(left: 0, top: 0, right: 100, bottom: 100),
                accessibilityLabel: "Counter"
            )
        )
    }

    func tap(x: Double, y: Double) throws {
        calls.append("tap:\(x),\(y)")
    }

    func tap(identifier: String) throws {
        calls.append("tap:\(identifier)")
    }

    func swipe(_ direction: WatchSwipeDirection) throws {
        calls.append(direction.rawValue)
    }
}

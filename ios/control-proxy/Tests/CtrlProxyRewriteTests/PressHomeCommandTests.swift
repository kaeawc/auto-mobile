@testable import CtrlProxyRewrite
import Foundation
import XCTest

@MainActor
final class PressHomeCommandTests: XCTestCase {
    func testNoOpHomePressDoesNotChangeTrackedForeground() async throws {
        let locator = RewriteFakeElementLocator()
        locator.foregroundBundleId = "com.example.app"
        let gestures = RewriteFakeGesturePerformer()
        let handler = CommandHandler(elementLocator: locator, gesturePerformer: gestures, perf: PerfProvider())
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"request_press_home","requestId":"home-1"}"#.utf8
        ))

        let result = await handler.handle(request)
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.success, false)
        XCTAssertEqual(response.error, "Home press did not bring SpringBoard to the foreground")
        XCTAssertEqual(locator.foregroundBundleId, "com.example.app")
    }

    func testVerifiedHomePressUpdatesTrackedForeground() async throws {
        let locator = RewriteFakeElementLocator()
        locator.foregroundBundleId = "com.example.app"
        let gestures = RewriteFakeGesturePerformer()
        gestures.onPressHome = { locator.foregroundBundleId = "com.apple.springboard" }
        let handler = CommandHandler(elementLocator: locator, gesturePerformer: gestures, perf: PerfProvider())
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"request_press_home","requestId":"home-2"}"#.utf8
        ))

        let result = await handler.handle(request)
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(locator.foregroundBundleId, "com.apple.springboard")
    }
}

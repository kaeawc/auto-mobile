@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class PressKeyTests: XCTestCase {
    func testDecodePreservesKeyAndModifiersAndResponseType() throws {
        let request = try JSONDecoder().decode(WebSocketRequest.self, from: Data(
            #"{"type":"request_press_key","requestId":"key-1","key":"tab","modifiers":["shift","meta"]}"#.utf8
        ))
        guard case let .pressKey(payload) = request else { return XCTFail("Expected pressKey") }
        XCTAssertEqual(payload.key, "tab")
        XCTAssertEqual(payload.modifiers, ["shift", "meta"])
        XCTAssertEqual(payload.requestId, "key-1")
        XCTAssertEqual(request.requestType, .requestPressKey)
        XCTAssertEqual(RequestType.requestPressKey.responseType, .pressKeyResult)
    }
}

@MainActor
final class PressKeyDispatchTests: XCTestCase {
    func testPressKeyForwardsModifiersAndPreservesFailure() async throws {
        let gestures = RewriteFakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(),
            gesturePerformer: gestures,
            perf: PerfProvider()
        )
        let request = WebSocketRequest.pressKey(RequestPressKey(
            requestId: "key-1", key: "tab", modifiers: ["shift", "meta"]
        ))
        let result = await handler.handle(request)
        let response = try XCTUnwrap(result as? WebSocketResponse)
        XCTAssertEqual(response.type, "press_key_result")
        XCTAssertEqual(response.requestId, "key-1")
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(gestures.keyCalls.count, 1)
        XCTAssertEqual(gestures.keyCalls.first?.0, "tab")
        XCTAssertEqual(gestures.keyCalls.first?.1, ["shift", "meta"])
        gestures.keyError = .executionFailed("No focus")
        let failedResult = await handler.handle(request)
        let failure = try XCTUnwrap(failedResult as? WebSocketResponse)
        XCTAssertEqual(failure.success, false)
        XCTAssertEqual(failure.type, "press_key_result")
        XCTAssertEqual(failure.requestId, "key-1")
        XCTAssertEqual(gestures.keyCalls.count, 1)
    }
}

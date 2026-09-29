@testable import CtrlProxyRewrite
import Foundation
import XCTest

@MainActor
final class FrameContextFencingTests: XCTestCase {
    private typealias Fields = [String: Any]

    private func dispatch(
        type: RequestType,
        fields: Fields,
        token: String?
    )
        async throws -> (WebSocketResponse, RewriteFakeGesturePerformer)
    {
        let hierarchy = RewriteFakeElementLocator.defaultHierarchy
        let frameContext = FrameContext()
        let current = try XCTUnwrap(frameContext.recordTransition(to: hierarchy))
        var payload = fields
        payload["type"] = type.rawValue
        payload["requestId"] = "fence-test"
        if let token {
            payload["frameContext"] = token == "current" ? current : token
        }
        let request = try JSONDecoder().decode(
            WebSocketRequest.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
        let gestures = RewriteFakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: RewriteFakeElementLocator(hierarchy: hierarchy),
            gesturePerformer: gestures,
            perf: PerfProvider(),
            frameContext: frameContext
        )
        let result = await handler.handle(request)
        return try (XCTUnwrap(result as? WebSocketResponse), gestures)
    }

    private func calls(for type: RequestType, on gestures: RewriteFakeGesturePerformer) -> Int {
        switch type {
        case .requestMultiFingerSwipe: gestures.multiFingerSwipeCalls
        case .requestPinch: gestures.pinchCalls
        case .requestClearText: gestures.clearTextCalls
        case .requestImeAction: gestures.imeActionCalls
        case .requestSelectAll: gestures.selectAllCalls
        case .requestPressKey: gestures.keyCalls.count
        case .requestShake: gestures.shakeCalls
        case .requestAction: gestures.actionCalls
        case .requestActivateAccessibilityLink: gestures.activateAccessibilityLinkCalls + gestures.tapCalls
        default: 0
        }
    }

    private func assertStale(
        _ type: RequestType,
        fields: Fields = [:],
        file: StaticString = #filePath,
        line: UInt = #line
    )
        async throws
    {
        let (response, gestures) = try await dispatch(type: type, fields: fields, token: "stale-token")
        XCTAssertEqual(response.success, false, file: file, line: line)
        XCTAssertTrue(response.error?.localizedCaseInsensitiveContains("stale") == true, file: file, line: line)
        XCTAssertEqual(calls(for: type, on: gestures), 0, file: file, line: line)
    }

    private func assertCurrent(
        _ type: RequestType,
        fields: Fields = [:],
        file: StaticString = #filePath,
        line: UInt = #line
    )
        async throws
    {
        let (response, gestures) = try await dispatch(type: type, fields: fields, token: "current")
        XCTAssertEqual(response.success, true, file: file, line: line)
        XCTAssertEqual(calls(for: type, on: gestures), 1, file: file, line: line)
    }

    func testMultiFingerSwipeRejectsStaleContext() async throws {
        try await assertStale(.requestMultiFingerSwipe, fields: swipeFields)
    }

    func testMultiFingerSwipeAcceptsCurrentContext() async throws {
        try await assertCurrent(.requestMultiFingerSwipe, fields: swipeFields)
    }

    func testPinchRejectsStaleContext() async throws {
        try await assertStale(.requestPinch, fields: pinchFields)
    }

    func testPinchAcceptsCurrentContext() async throws {
        try await assertCurrent(.requestPinch, fields: pinchFields)
    }

    func testClearTextRejectsStaleContext() async throws {
        try await assertStale(.requestClearText)
    }

    func testClearTextAcceptsCurrentContext() async throws {
        try await assertCurrent(.requestClearText)
    }

    func testImeActionRejectsStaleContext() async throws {
        try await assertStale(.requestImeAction, fields: ["action": "done"])
    }

    func testImeActionAcceptsCurrentContext() async throws {
        try await assertCurrent(.requestImeAction, fields: ["action": "done"])
    }

    func testSelectAllRejectsStaleContext() async throws {
        try await assertStale(.requestSelectAll)
    }

    func testSelectAllAcceptsCurrentContext() async throws {
        try await assertCurrent(.requestSelectAll)
    }

    func testPressKeyRejectsStaleContext() async throws {
        try await assertStale(.requestPressKey, fields: keyFields)
    }

    func testPressKeyAcceptsCurrentContext() async throws {
        try await assertCurrent(.requestPressKey, fields: keyFields)
    }

    func testShakeRejectsStaleContext() async throws {
        try await assertStale(.requestShake)
    }

    func testShakeAcceptsCurrentContext() async throws {
        try await assertCurrent(.requestShake)
    }

    func testActionRejectsStaleContext() async throws {
        try await assertStale(.requestAction, fields: ["action": "click"])
    }

    func testActionAcceptsCurrentContext() async throws {
        try await assertCurrent(.requestAction, fields: ["action": "click"])
    }

    func testAccessibilityLinkRejectsStaleContext() async throws {
        try await assertStale(.requestActivateAccessibilityLink, fields: linkFields)
    }

    func testAccessibilityLinkAcceptsCurrentContext() async throws {
        try await assertCurrent(.requestActivateAccessibilityLink, fields: linkFields)
    }

    func testContextlessRequestUsesFastPath() async throws {
        let (response, gestures) = try await dispatch(type: .requestShake, fields: [:], token: nil)
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(gestures.shakeCalls, 1)
    }

    private var swipeFields: Fields { ["x1": 1, "y1": 2, "x2": 3, "y2": 4] }
    private var pinchFields: Fields {
        ["centerX": 1, "centerY": 2, "distanceStart": 10, "distanceEnd": 20]
    }

    private var keyFields: Fields { ["key": "tab", "modifiers": [String]()] }
    private var linkFields: Fields { ["text": "Help", "occurrence": 0] }
}

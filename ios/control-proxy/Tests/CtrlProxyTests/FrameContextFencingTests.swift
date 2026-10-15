@testable import CtrlProxy
import Foundation
import XCTest

@MainActor
final class FrameContextFencingTests: XCTestCase {
    private typealias Fields = [String: Any]

    private func dispatch(
        type: RequestType,
        fields: Fields,
        token: String?,
        locator: FakeElementLocator? = nil
    )
        async throws -> (WebSocketResponse, FakeGesturePerformer)
    {
        let hierarchy = FakeElementLocator.defaultHierarchy
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
        let gestures = FakeGesturePerformer()
        let handler = CommandHandler(
            elementLocator: locator ?? FakeElementLocator(hierarchy: hierarchy),
            gesturePerformer: gestures,
            perf: PerfProvider(),
            frameContext: frameContext
        )
        let result = await handler.handle(request)
        return try (XCTUnwrap(result as? WebSocketResponse), gestures)
    }

    private func calls(for type: RequestType, on gestures: FakeGesturePerformer) -> Int {
        switch type {
        case .requestMultiFingerSwipe: gestures.multiFingerSwipeCalls
        case .requestPinch: gestures.pinchCalls
        case .requestSetText: gestures.setTextCalls
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
        XCTAssertEqual(
            response.error,
            "Command execution failed: Stale frame context; observe a fresh frame before retrying",
            file: file, line: line
        )
        XCTAssertNil(response.errorCode, file: file, line: line)
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

    func testDoubleTapContextIsCheckedBeforeDispatch() async throws {
        for token in ["stale-token", "current"] {
            let (response, gestures) = try await dispatch(
                type: .requestTapCoordinates,
                fields: ["x": 12.5, "y": 24.25, "doubleTap": true],
                token: token
            )
            XCTAssertEqual(response.success, token == "current")
            XCTAssertEqual(gestures.tapCalls, 0)
            XCTAssertEqual(gestures.doubleTapPoints.count, token == "current" ? 1 : 0)
            if token != "current" { XCTAssertTrue(response.error?.contains("Stale frame context") == true) }
        }
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

    func testSetTextRejectsStaleContext() async throws {
        try await assertStale(.requestSetText, fields: ["resourceId": "field", "text": "value"])
    }

    func testSetTextAcceptsCurrentContext() async throws {
        try await assertCurrent(.requestSetText, fields: ["resourceId": "field", "text": "value"])
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
        let locator = FakeElementLocator()
        locator.onCapture = { throw CaptureFailure() }
        let (response, gestures) = try await dispatch(
            type: .requestShake, fields: [:], token: nil, locator: locator
        )
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(gestures.shakeCalls, 1)
        XCTAssertTrue(locator.filteringRequests.isEmpty)
    }

    func testSyncGestureCaptureFailureIsNotStaleAndDoesNotSendGesture() async throws {
        let locator = FakeElementLocator()
        locator.onCapture = { throw CaptureFailure() }
        let (response, gestures) = try await dispatch(
            type: .requestShake, fields: [:], token: "current", locator: locator
        )
        XCTAssertEqual(response.success, false)
        let message = try XCTUnwrap(response.error)
        XCTAssertFalse(message.localizedCaseInsensitiveContains("stale"))
        XCTAssertTrue(message.contains("XCUITest hierarchy query timed out"))
        XCTAssertEqual(response.errorCode, "hierarchy_capture_failed")
        XCTAssertEqual(gestures.shakeCalls, 0)
        XCTAssertEqual(locator.filteringRequests.count, 1)
    }

    func testAsyncGestureCaptureFailureIsNotStaleAndDoesNotSendGesture() async throws {
        let locator = FakeElementLocator()
        locator.onCapture = { throw CaptureFailure() }
        let (response, gestures) = try await dispatch(
            type: .requestSetText, fields: ["resourceId": "field", "text": "value"],
            token: "current", locator: locator
        )
        XCTAssertEqual(response.success, false)
        let message = try XCTUnwrap(response.error)
        XCTAssertFalse(message.localizedCaseInsensitiveContains("stale"))
        XCTAssertTrue(message.contains("XCUITest hierarchy query timed out"))
        XCTAssertEqual(response.errorCode, "hierarchy_capture_failed")
        XCTAssertEqual(gestures.setTextCalls, 0)
        XCTAssertEqual(locator.filteringRequests.count, 1)
    }

    func testContextlessAsyncGestureSkipsFailingCapture() async throws {
        let locator = FakeElementLocator()
        locator.onCapture = { throw CaptureFailure() }
        let (response, gestures) = try await dispatch(
            type: .requestSetText, fields: ["resourceId": "field", "text": "value"],
            token: nil, locator: locator
        )
        XCTAssertEqual(response.success, true)
        XCTAssertEqual(gestures.setTextCalls, 1)
        XCTAssertTrue(locator.filteringRequests.isEmpty)
    }

    func testHierarchyCaptureFailureWireContract() {
        let error = CommandError.hierarchyCaptureFailed(reason: "x")
        XCTAssertEqual(error.wireCode, "hierarchy_capture_failed")
        XCTAssertEqual(
            error.errorDescription,
            "Could not capture the view hierarchy to validate the frame context; the gesture was not sent: x"
        )
    }

    private struct CaptureFailure: LocalizedError {
        var errorDescription: String? { "XCUITest hierarchy query timed out" }
    }

    private var swipeFields: Fields { ["x1": 1, "y1": 2, "x2": 3, "y2": 4] }
    private var pinchFields: Fields {
        ["centerX": 1, "centerY": 2, "distanceStart": 10, "distanceEnd": 20]
    }

    private var keyFields: Fields { ["key": "tab", "modifiers": [String]()] }
    private var linkFields: Fields { ["text": "Help", "occurrence": 0] }
}

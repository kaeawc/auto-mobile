@testable import CtrlProxy
import ObjCExceptionCatcher
import XCTest

final class ObjCExceptionBridgeTests: XCTestCase {

    // MARK: - Success Cases

    func testCatchingObjCExceptionReturnsValueOnSuccess() throws {
        let result = try catchingObjCException { 42 }
        XCTAssertEqual(result, 42)
    }

    func testCatchingObjCExceptionThrowingOverloadReturnsValueOnSuccess() throws {
        let result = try catchingObjCException { () throws -> String in
            return "hello"
        }
        XCTAssertEqual(result, "hello")
    }

    // MARK: - Swift Error Passthrough

    func testCatchingObjCExceptionPassesThroughSwiftError() {
        let expectedError = CommandError.executionFailed("test failure")

        XCTAssertThrowsError(
            try catchingObjCException { () throws -> Int in
                throw expectedError
            }
        ) { error in
            guard let commandError = error as? CommandError else {
                XCTFail("Expected CommandError, got \(type(of: error))")
                return
            }
            if case .executionFailed(let message) = commandError {
                XCTAssertEqual(message, "test failure")
            } else {
                XCTFail("Expected executionFailed case")
            }
        }
    }

    func testCatchingObjCExceptionPassesThroughNSError() {
        let nsError = NSError(domain: "TestDomain", code: 99, userInfo: [
            NSLocalizedDescriptionKey: "NSError passthrough",
        ])

        XCTAssertThrowsError(
            try catchingObjCException { () throws -> Int in
                throw nsError
            }
        ) { error in
            let caught = error as NSError
            XCTAssertEqual(caught.domain, "TestDomain")
            XCTAssertEqual(caught.code, 99)
        }
    }

    // MARK: - ObjCExceptionError

    func testObjCExceptionErrorDescription() {
        let error = ObjCExceptionError(name: "NSRangeException", reason: "index 5 beyond bounds [0..3]")
        XCTAssertEqual(
            error.errorDescription,
            "NSException(NSRangeException): index 5 beyond bounds [0..3]"
        )
    }

    func testObjCExceptionErrorDescriptionWithNilReason() {
        let error = ObjCExceptionError(name: "NSInvalidArgumentException", reason: nil)
        XCTAssertEqual(
            error.errorDescription,
            "NSException(NSInvalidArgumentException): no reason"
        )
    }

    func testObjCExceptionErrorFromNSException() {
        let exception = NSException(
            name: .rangeException,
            reason: "test reason",
            userInfo: nil
        )
        let error = ObjCExceptionError(exception: exception)
        XCTAssertEqual(error.name, "NSRangeException")
        XCTAssertEqual(error.reason, "test reason")
    }

    // MARK: - WebSocketServer Error Response Helpers

    func testBuildErrorResponseDataProducesValidJSON() throws {
        let error = ObjCExceptionError(name: "NSRangeException", reason: "index out of bounds")
        let data = WebSocketServer.buildErrorResponseData(requestId: "req-123", error: error)

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?["type"] as? String, "error")
        XCTAssertEqual(json?["success"] as? Bool, false)
        XCTAssertEqual(json?["requestId"] as? String, "req-123")
        let errorMessage = json?["error"] as? String
        XCTAssertTrue(errorMessage?.contains("NSRangeException") ?? false)
        XCTAssertTrue(errorMessage?.contains("index out of bounds") ?? false)
    }

    func testBuildErrorResponseDataWithNilRequestId() throws {
        let error = NSError(domain: "test", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "something failed",
        ])
        let data = WebSocketServer.buildErrorResponseData(requestId: nil, error: error)

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?["type"] as? String, "error")
        XCTAssertEqual(json?["success"] as? Bool, false)
        XCTAssertTrue(json?["requestId"] is NSNull || json?["requestId"] == nil)
        let errorMessage = json?["error"] as? String
        XCTAssertTrue(errorMessage?.contains("something failed") ?? false)
    }

    func testBuildErrorResponseDataWithSpecialCharactersInError() throws {
        let error = ObjCExceptionError(
            name: "NSException",
            reason: "contains \"quotes\" and \\backslash\\ chars"
        )
        let data = WebSocketServer.buildErrorResponseData(requestId: "req-special", error: error)

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(json, "Response should always be valid JSON even with special characters")
        XCTAssertEqual(json?["requestId"] as? String, "req-special")
    }

    func testBuildErrorResponseDataHasTimestamp() throws {
        let beforeMs = Int64(Date().timeIntervalSince1970 * 1000)
        let error = NSError(domain: "test", code: 0, userInfo: nil)
        let data = WebSocketServer.buildErrorResponseData(requestId: nil, error: error)
        let afterMs = Int64(Date().timeIntervalSince1970 * 1000)

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let timestamp = json?["timestamp"] as? Int64
        XCTAssertNotNil(timestamp)
        if let ts = timestamp {
            XCTAssertGreaterThanOrEqual(ts, beforeMs)
            XCTAssertLessThanOrEqual(ts, afterMs)
        }
    }

    // MARK: - Pinch Symbol Availability (issue #2910)

    /// Off-device (this test host is macOS, not iOS), the private XCTest pinch
    /// symbols are definitionally unavailable, so `synthesizePinch` must report
    /// `symbolsUnavailable == true` and fail — this is exactly the signal that
    /// tells `GesturePerformer.pinch` to take the public-API fallback path.
    func testSynthesizePinchReportsSymbolsUnavailableOffDevice() {
        var symbolsUnavailable: ObjCBool = false
        var errorMessage: NSString?
        let succeeded = ObjCExceptionCatcher_synthesizePinch(
            100, 200, 40, 120, 0, 0.3, 0, &symbolsUnavailable, &errorMessage
        )
        XCTAssertFalse(succeeded, "private synthesis cannot succeed off-device")
        XCTAssertTrue(symbolsUnavailable.boolValue, "must flag the private symbols as unavailable")
        XCTAssertNotNil(errorMessage)
    }

    // MARK: - Multi-Finger Swipe Symbol Availability (issue #2952)

    /// Mirrors the pinch case above: off-device the private XCTest symbols are
    /// definitionally unavailable, so `synthesizeMultiFingerSwipe` must report
    /// `symbolsUnavailable == true` rather than conflating the availability gap
    /// with a genuine synthesis error. Unlike pinch there is no public-API
    /// fallback to take (see `MultiFingerSwipeDiagnostics`); the signal instead
    /// selects a distinct, actionable failure message.
    func testSynthesizeMultiFingerSwipeReportsSymbolsUnavailableOffDevice() {
        var symbolsUnavailable: ObjCBool = false
        var errorMessage: NSString?
        let succeeded = ObjCExceptionCatcher_synthesizeMultiFingerSwipe(
            10, 20, 110, 220, 2, 25, 0.3, 0, &symbolsUnavailable, &errorMessage
        )
        XCTAssertFalse(succeeded, "private synthesis cannot succeed off-device")
        XCTAssertTrue(symbolsUnavailable.boolValue, "must flag the private symbols as unavailable")
        XCTAssertNotNil(errorMessage)
    }
}

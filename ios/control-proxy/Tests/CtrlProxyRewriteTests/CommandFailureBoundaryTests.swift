@testable import CtrlProxyRewrite
import Foundation
import XCTest

private struct IntentionallyUnencodableResponse: WebSocketResponsePayload {
    func encode(to _: any Encoder) throws {
        throw IntentionalEncodingFailure()
    }
}

private struct IntentionalEncodingFailure: LocalizedError {
    var errorDescription: String? { "Intentional response encoding failure" }
}

final class CommandFailureBoundaryTests: XCTestCase {
    private func decodeObject(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    func testDeflectedFailureReplacesSuccessWithCorrelatedError() {
        let coordinator = CommandFailureCoordinator()
        let exp = expectation(description: "error sent")
        let responder = CapturingResponder(onEach: { exp.fulfill() })
        let server = makeTestServer(
            failureCoordinator: coordinator,
            handler: { request in
                _ = coordinator.recordDeflectedFailure("Failed to synthesize event")
                return WebSocketResponse.success(
                    type: "press_key_result",
                    requestId: request.requestId,
                    totalTimeMs: 1
                )
            }
        )

        server.dispatchCommand(
            Data(
                #"{"type":"request_press_key","requestId":"failure-boundary-1","key":"ENTER","modifiers":[]}"#.utf8
            ),
            responder: responder
        )
        wait(for: [exp], timeout: 2)

        let object = decodeObject(responder.captured[0])
        XCTAssertEqual(object?["type"] as? String, "error")
        XCTAssertEqual(object?["success"] as? Bool, false)
        XCTAssertEqual(object?["requestId"] as? String, "failure-boundary-1")
        XCTAssertTrue((object?["error"] as? String)?.contains("Failed to synthesize event") == true)
    }

    func testDeflectedFailureIsFoldedIntoCaughtError() {
        let coordinator = CommandFailureCoordinator()
        let exp = expectation(description: "error sent")
        let responder = CapturingResponder(onEach: { exp.fulfill() })
        let server = makeTestServer(
            failureCoordinator: coordinator,
            handler: { _ in
                _ = coordinator.recordDeflectedFailure("Recorded synthesis failure")
                return IntentionallyUnencodableResponse()
            }
        )

        server.dispatchCommand(
            Data(#"{"type":"request_screenshot","requestId":"failure-boundary-2"}"#.utf8),
            responder: responder
        )
        wait(for: [exp], timeout: 2)

        let object = decodeObject(responder.captured[0])
        XCTAssertEqual(object?["type"] as? String, "error")
        XCTAssertEqual(object?["success"] as? Bool, false)
        XCTAssertEqual(object?["requestId"] as? String, "failure-boundary-2")
        let error = object?["error"] as? String
        XCTAssertTrue(error?.contains("Intentional response encoding failure") == true)
        XCTAssertTrue(error?.contains("Recorded synthesis failure") == true)
    }

    func testDeflectedFailurePreservesHandlerErrorTypeTimingAndMessage() {
        let coordinator = CommandFailureCoordinator()
        let exp = expectation(description: "error sent")
        let responder = CapturingResponder(onEach: { exp.fulfill() })
        let server = makeTestServer(failureCoordinator: coordinator, handler: { request in
            _ = coordinator.recordDeflectedFailure("XCTest tap issue")
            return WebSocketResponse.error(
                type: "set_text_result", requestId: request.requestId,
                error: "Keyboard focus failed", totalTimeMs: 27
            )
        }, flush: [PerfTiming(name: "handler", durationMs: 3)])

        server.dispatchCommand(
            Data(#"{"type":"request_set_text","requestId":"failure-boundary-3","text":"hi"}"#.utf8),
            responder: responder
        )
        wait(for: [exp], timeout: 2)

        let object = decodeObject(responder.captured[0])
        XCTAssertEqual(object?["type"] as? String, "set_text_result")
        XCTAssertEqual(object?["totalTimeMs"] as? Int, 27)
        XCTAssertEqual(object?["requestId"] as? String, "failure-boundary-3")
        XCTAssertEqual(object?["success"] as? Bool, false)
        XCTAssertNotNil(object?["perfTiming"])
        let error = object?["error"] as? String
        XCTAssertTrue(error?.contains("Keyboard focus failed") == true)
        XCTAssertTrue(error?.contains("XCTest tap issue") == true)
    }

    func testFailureDescriptionsHaveCountAndByteBoundsWithTruncationIndicator() {
        let coordinator = CommandFailureCoordinator()
        coordinator.begin(requestId: "bounded")
        for _ in 0 ..< 100 {
            XCTAssertTrue(coordinator.recordDeflectedFailure(String(repeating: "🌍", count: 1000)))
        }
        let failures = coordinator.finish()
        XCTAssertLessThanOrEqual(failures.count, CommandFailureCoordinator.maxFailures + 1)
        XCTAssertLessThanOrEqual(failures.joined().utf8.count, CommandFailureCoordinator.maxDescriptionBytes)
        XCTAssertTrue(failures.last?.contains("truncated") == true)

        coordinator.begin(requestId: "count-bound")
        for _ in 0 ..< 100 {
            XCTAssertTrue(coordinator.recordDeflectedFailure("short"))
        }
        let countBoundFailures = coordinator.finish()
        XCTAssertEqual(countBoundFailures.count, CommandFailureCoordinator.maxFailures + 1)
        XCTAssertTrue(countBoundFailures.last?.contains("truncated") == true)
    }

    func testFinishAtomicallyClosesFailureWindow() {
        let coordinator = CommandFailureCoordinator()
        coordinator.begin(requestId: "atomic")
        XCTAssertTrue(coordinator.recordDeflectedFailure("first"))
        XCTAssertEqual(coordinator.finish(), ["first"])
        XCTAssertFalse(coordinator.recordDeflectedFailure("late"))
        XCTAssertEqual(coordinator.finish(), [])
    }

    func testFailureOutsideCommandIsNotDeflected() {
        let coordinator = CommandFailureCoordinator()

        XCTAssertFalse(coordinator.recordDeflectedFailure("setup failed"))
        XCTAssertEqual(coordinator.finish(), [])
    }
}
